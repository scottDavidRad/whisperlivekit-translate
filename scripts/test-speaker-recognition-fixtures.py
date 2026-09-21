#!/usr/bin/env python3
"""Create synthetic Russian speaker fixtures; writes files without playback.

Requires macOS `say`, FFmpeg, and the fixture-only edge-tts command through uvx.
The app does not depend on edge-tts. No real person's recording is used here.
"""
import argparse
import json
import subprocess
import wave
from pathlib import Path

UTTERANCES = {
    "milena-enroll": ("Milena", "Доброе утро. Сегодня мы обсуждаем план нашей поездки. Я предлагаю встретиться около вокзала в девять часов. Возьмите с собой билеты и документы. После встречи мы вместе позавтракаем в небольшом кафе."),
    "milena-recall": ("Milena", "На следующей неделе я хочу посетить выставку современного искусства. Моя подруга уже купила билеты. Мы будем смотреть картины и фотографии, а вечером погуляем по набережной. Надеюсь, погода будет хорошей."),
    "milena-return": ("Milena", "Отлично. Я подготовлю список вопросов и отправлю его завтра утром. Пожалуйста, проверьте адрес и время нашей следующей встречи. Большое спасибо за вашу помощь и внимание."),
    "dmitry-enroll": ("ru-RU-DmitryNeural", "Хорошо, я проверю расписание поездов и закажу билеты сегодня вечером. Нам нужно выбрать удобные места и подготовить небольшой список вещей. Если у вас появятся вопросы, позвоните мне после обеда."),
    "dmitry-recall": ("ru-RU-DmitryNeural", "Вчера я закончил читать интересную книгу о путешествиях. Автор рассказывает о небольших городах и старинных зданиях. Теперь я хочу спланировать короткий отпуск и увидеть эти места своими глазами."),
    "dmitry-return": ("ru-RU-DmitryNeural", "Спасибо за подробное объяснение. Я сохраню эту информацию и поговорю с коллегами. Когда мы примем решение, я сразу отправлю вам сообщение. До встречи на следующей неделе."),
    "unknown-svetlana": ("ru-RU-SvetlanaNeural", "Здравствуйте. Я впервые участвую в этой встрече и хотела бы задать несколько вопросов. Расскажите, пожалуйста, о сроках проекта и основных задачах нашей команды. Я внимательно запишу всю необходимую информацию."),
}


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def concat(output, parts):
    frames, turns = [], []
    samples = 0
    for index, path in enumerate(parts):
        if index:
            frames.append(bytes(16000 * 2))
            samples += 16000
        with wave.open(str(path), "rb") as wav:
            assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
            data = wav.readframes(wav.getnframes())
        start = samples / 16000
        frames.append(data)
        samples += len(data) // 2
        turns.append({"file": path.name, "start": start, "end": samples / 16000})
    with wave.open(str(output), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"".join(frames))
    return {"duration": samples / 16000, "turns": turns}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(".test-output/speaker-recognition"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {"synthetic": True, "language": "ru", "utterances": {}, "sessions": {}}
    for key, (voice, text) in UTTERANCES.items():
        wav = args.output / f"{key}.wav"
        source = args.output / f"{key}.{'aiff' if voice == 'Milena' else 'mp3'}"
        if not source.exists():
            if voice == "Milena":
                run("say", "-v", voice, "-r", "160", "-o", str(source), text)
            else:
                run("uvx", "--offline", "edge-tts", "--voice", voice, "--text", text, "--write-media", str(source))
        if not wav.exists():
            run("ffmpeg", "-v", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav))
        with wave.open(str(wav), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
        manifest["utterances"][key] = {"voice": voice, "text": text, "file": wav.name, "duration": duration}
        print(f"Created {key}: {duration:.2f}s", flush=True)
    for key, names in {
        "enroll": ["milena-enroll", "dmitry-enroll", "milena-return"],
        "recall-reversed": ["dmitry-recall", "milena-recall", "dmitry-return"],
        "unknown": ["unknown-svetlana"],
    }.items():
        manifest["sessions"][key] = concat(args.output / f"session-{key}.wav", [args.output / f"{name}.wav" for name in names])
    (args.output / "fixtures.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest["sessions"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
