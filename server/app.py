"""WhisperLiveKit server with isolated source-language settings per connection."""

import asyncio
import logging
import threading
from argparse import Namespace
from contextlib import asynccontextmanager, suppress
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from whisperlivekit import AudioProcessor, TranscriptionEngine, get_inline_ui_html, parse_args
from whisperlivekit.config import WhisperLiveKitConfig
from whisperlivekit.local_agreement.backends import FasterWhisperASR, MLXWhisper

if __package__:
    from .conversation import ConversationService, conversation_router
else:
    from conversation import ConversationService, conversation_router

logger = logging.getLogger(__name__)


class LiveFasterWhisperASR(FasterWhisperASR):
    """Use the configured beam count instead of the upstream fixed five beams."""

    def transcribe(self, audio, init_prompt=""):
        segments, _ = self.model.transcribe(
            audio,
            language=self.original_language,
            initial_prompt=init_prompt,
            beam_size=self.beam_size,
            word_timestamps=True,
            condition_on_previous_text=True,
            **self.transcribe_kargs,
        )
        return list(segments)


class LiveMLXWhisper(MLXWhisper):
    """Forward task selection to MLX; upstream WLK currently drops this option."""

    def transcribe(self, audio, init_prompt=""):
        # MLX streams and its cached audio transforms are thread-affine. WLK's
        # asyncio.to_thread can choose a different worker on every chunk.
        executor = getattr(self, "inference_executor", None)
        if executor is not None:
            return executor.submit(self._transcribe, audio).result()
        return self._transcribe(audio)

    def _transcribe(self, audio):
        with self.inference_lock:
            result = self.model(
                audio,
                language=self.original_language,
                task=self.transcribe_kargs.get("task", "transcribe"),
                # Reusing committed text can make short live chunks complete
                # an earlier sentence before the current words are spoken.
                initial_prompt=None,
                word_timestamps=True,
                condition_on_previous_text=False,
                temperature=0.0,
                path_or_hf_repo=self.model_size_or_path,
                verbose=None,
            )
        return result.get("segments", [])


def supported_languages(engine: TranscriptionEngine) -> list[str]:
    """Use the loaded model's vocabulary (small supports 99 languages, not Yue)."""
    if engine.config.backend == "mlx-whisper":
        from mlx_whisper.tokenizer import LANGUAGES
        from mlx_whisper.transcribe import ModelHolder
        model = ModelHolder.model
        return sorted(list(LANGUAGES)[:model.num_languages]) if model.is_multilingual else ["en"]
    model = engine.asr.model
    return [
        language for language in model.supported_languages
        if model.hf_tokenizer.token_to_id(f"<|{language}|>") is not None
    ]


def session_engine(shared: TranscriptionEngine, language: str, task: str | None = None) -> TranscriptionEngine:
    """Share model weights, never mutable language or decoding options.

    TranscriptionEngine.__new__ is a singleton; copy.copy(shared) would return
    that singleton. Allocate directly so AudioProcessor's isinstance check still
    accepts the engine while every connection owns its settings and ASR wrapper.
    """
    engine = object.__new__(TranscriptionEngine)
    engine.__dict__.update(shared.__dict__)
    task = task or ("translate" if shared.config.direct_english_translation else "transcribe")
    engine.config = replace(shared.config, lan=language, direct_english_translation=task == "translate")
    engine.args = Namespace(**vars(shared.args))
    engine.args.lan = language
    engine.args.direct_english_translation = task == "translate"
    asr_class = LiveMLXWhisper if shared.config.backend == "mlx-whisper" else LiveFasterWhisperASR
    engine.asr = object.__new__(asr_class)
    engine.asr.__dict__.update(shared.asr.__dict__)
    engine.asr.beam_size = shared.config.beams
    engine.asr.original_language = None if language == "auto" else language
    engine.asr.transcribe_kargs = dict(shared.asr.transcribe_kargs)
    engine.asr.transcribe_kargs["task"] = task
    return engine


def create_app(config: WhisperLiveKitConfig) -> FastAPI:
    if config.beams < 1:
        raise ValueError("--beams must be a positive integer.")
    if config.backend not in {"faster-whisper", "mlx-whisper"} or config.backend_policy != "localagreement":
        raise ValueError("Use --backend faster-whisper or mlx-whisper with --backend-policy localagreement.")
    if config.backend == "mlx-whisper" and config.beams != 1:
        raise ValueError("The MLX backend requires --beams 1.")
    if not config.pcm_input or not config.transcription:
        raise ValueError("This server requires --pcm-input and transcription enabled.")
    if config.target_language:
        raise ValueError("Use --direct-english-translation for English translation.")
    if config.buffer_trimming != "segment":
        raise ValueError("Use --buffer_trimming segment for per-session language selection.")
    if config.diarization and config.diarization_backend != "sortformer":
        raise ValueError("Use --diarization-backend sortformer for isolated speaker sessions.")

    conversation = ConversationService()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        mlx_executor = None
        try:
            if config.backend == "mlx-whisper":
                # Loading, optional warmup, cached transforms, and decoding all
                # run on one OS thread throughout this process's lifetime.
                mlx_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper-mlx")
                app.state.engine = await asyncio.get_running_loop().run_in_executor(
                    mlx_executor, lambda: TranscriptionEngine(config=config),
                )
                app.state.engine.asr.inference_lock = threading.Lock()
                app.state.engine.asr.inference_executor = mlx_executor
            else:
                app.state.engine = TranscriptionEngine(config=config)
            app.state.languages = supported_languages(app.state.engine)
            yield
        finally:
            await conversation.close()
            if mlx_executor is not None:
                mlx_executor.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type"], allow_credentials=False)
    app.include_router(conversation_router(conversation))

    def capabilities(language: str, task: str | None = None) -> dict:
        task = task or ("translate" if config.direct_english_translation else "transcribe")
        return {
            "source_language": language,
            "supported_languages": app.state.languages,
            "translation_mode": "english" if task == "translate" else "transcript",
            "diarization": config.diarization,
        }

    @app.get("/")
    async def index():
        return HTMLResponse(get_inline_ui_html())

    @app.get("/health")
    async def health():
        return {
            "status": "ready", **capabilities(config.lan),
            "beam_size": config.beams,
            "backend": config.backend,
            "compute_type": "float16" if config.backend == "mlx-whisper" else app.state.engine.asr.model.model.compute_type,
        }

    @app.websocket("/asr")
    async def asr(websocket: WebSocket):
        language = websocket.query_params.get("language", config.lan)
        task = websocket.query_params.get("task", "translate" if config.direct_english_translation else "transcribe")
        await websocket.accept()
        if task not in {"translate", "transcribe"}:
            await websocket.send_json({"type": "error", "error": "Unsupported task. Choose translate or transcribe."})
            await websocket.close(code=1008)
            return
        if language != "auto" and language not in app.state.languages:
            await websocket.send_json({
                "type": "error",
                "error": f"Unsupported source language: {language}. Choose Auto or a supported language.",
            })
            await websocket.close(code=1008)
            return

        processor = None
        results_task = None

        async def send_results(results):
            try:
                async for response in results:
                    await websocket.send_json(response.to_dict())
                await websocket.send_json({"type": "ready_to_stop"})
            except WebSocketDisconnect:
                pass
            except Exception:
                logger.exception("Failed to deliver transcription results")
                with suppress(Exception):
                    await websocket.send_json({"type": "error", "error": "WhisperLiveKit audio processing failed."})
                    await websocket.close(code=1011)

        try:
            engine = session_engine(app.state.engine, language, task)
            processor = AudioProcessor(transcription_engine=engine)
            results = await processor.create_tasks()
            await websocket.send_json({
                "type": "config", "useAudioWorklet": True, **capabilities(language, task),
            })
            results_task = asyncio.create_task(send_results(results))
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is None:
                    await websocket.send_json({"type": "error", "error": "Send 16 kHz mono PCM s16le as binary frames."})
                    await websocket.close(code=1003)
                    break
                # Empty binary frames retain WhisperLiveKit's graceful drain.
                await processor.process_audio(data)
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("WhisperLiveKit connection failed")
            with suppress(Exception):
                await websocket.send_json({"type": "error", "error": "WhisperLiveKit could not process this audio session."})
                await websocket.close(code=1011)
        finally:
            if results_task is not None:
                results_task.cancel()
                with suppress(asyncio.CancelledError):
                    await results_task
            if processor is not None:
                await processor.cleanup()

    return app


def main():
    import uvicorn

    config = parse_args()
    if bool(config.ssl_certfile) != bool(config.ssl_keyfile):
        raise ValueError("Both --ssl-certfile and --ssl-keyfile are required for TLS.")
    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        log_level=config.log_level.lower(),
        ssl_certfile=config.ssl_certfile,
        ssl_keyfile=config.ssl_keyfile,
        forwarded_allow_ips=config.forwarded_allow_ips,
    )


if __name__ == "__main__":
    main()
