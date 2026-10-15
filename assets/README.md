# Test recording

`test-voice.wav` is a real, locally rendered 9.105-second mono 24 kHz, 16-bit PCM
speech recording. It is **not ElevenLabs output**. Its spoken content is:

> This is the Voice Bubble playback test. You can pause, seek, and change the speed.
> This is a local test recording. No paid voice generation was used.

It was created once using the system FFmpeg `flite` filter and the bundled `slt`
voice. Normal application startup only reads the committed WAV; FFmpeg/Flite are
not runtime dependencies. No recording was taken from a person or another plugin.
The UI marks it “测试音频”; the tool result also identifies it as a local test recording.

Reproduction (optional; FFmpeg with libflite required):

```bash
ffmpeg -f lavfi \
  -i "flite=text='This is the Voice Bubble playback test. You can pause, seek, and change the speed. This is a local test recording. No paid voice generation was used.':voice=slt" \
  -ar 24000 -ac 1 -c:a pcm_s16le -map_metadata -1 assets/test-voice.wav
```

The waveform is calculated from the recording's PCM samples, not an animation or
random bars. Flite upstream attribution and licensing:
https://github.com/festvox/flite and https://github.com/festvox/flite/blob/master/COPYING.
No Flite executable or voice model is distributed with this project.
