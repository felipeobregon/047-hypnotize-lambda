import { execFile } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

const s3 = new S3Client();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const S3_BUCKET = process.env.S3_BUCKET!;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";

interface Event {
  texts: string[];
  gapSeconds?: number;
  voiceId?: string;
  outputKey?: string;
}

async function textToSpeech(text: string, voiceId: string): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function generateSilence(
  durationSeconds: number,
  outputPath: string
): Promise<void> {
  await execFileAsync(FFMPEG_PATH, [
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", String(durationSeconds),
    "-q:a", "9",
    "-acodec", "libmp3lame",
    "-y",
    outputPath,
  ]);
}

async function concatenateAudio(
  filePaths: string[],
  outputPath: string
): Promise<void> {
  const fileListContent = filePaths
    .map((fp) => `file '${fp}'`)
    .join("\n");
  const fileListPath = "/tmp/tts/filelist.txt";
  await writeFile(fileListPath, fileListContent);

  await execFileAsync(FFMPEG_PATH, [
    "-f", "concat",
    "-safe", "0",
    "-i", fileListPath,
    "-c", "copy",
    "-y",
    outputPath,
  ]);
}

export const handler = async (event: Event) => {
  const { texts, gapSeconds = 1, voiceId, outputKey } = event;
  const voice = voiceId || DEFAULT_VOICE_ID;

  if (!texts || !Array.isArray(texts) || texts.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "texts must be a non-empty array of strings" }),
    };
  }

  const workDir = "/tmp/tts";
  await mkdir(workDir, { recursive: true });

  // Fetch TTS audio for all texts in parallel
  const audioBuffers = await Promise.all(
    texts.map((text) => textToSpeech(text, voice))
  );

  // Write clips to disk
  const clipPaths: string[] = [];
  for (let i = 0; i < audioBuffers.length; i++) {
    const clipPath = `${workDir}/clip_${i}.mp3`;
    await writeFile(clipPath, audioBuffers[i]);
    clipPaths.push(clipPath);
  }

  // Generate silence gap
  const silencePath = `${workDir}/silence.mp3`;
  await generateSilence(gapSeconds, silencePath);

  // Build interleaved list: clip, silence, clip, silence, ..., clip
  const interleavedPaths: string[] = [];
  for (let i = 0; i < clipPaths.length; i++) {
    interleavedPaths.push(clipPaths[i]);
    if (i < clipPaths.length - 1) {
      interleavedPaths.push(silencePath);
    }
  }

  // Concatenate all audio into one file
  const outputPath = `${workDir}/output.mp3`;
  await concatenateAudio(interleavedPaths, outputPath);

  // Upload to S3
  const key = outputKey || `tts-output/${randomUUID()}.mp3`;
  const outputBuffer = await readFile(outputPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: outputBuffer,
      ContentType: "audio/mpeg",
    })
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      bucket: S3_BUCKET,
      key,
      clipCount: texts.length,
      gapSeconds,
    }),
  };
};
