import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Frames per second that spread `max` stills over the whole video (one a second when the length is unknown). */
export function frameRate(seconds: number | null, max: number): string {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "1";
    return `${max}/${Math.max(seconds, 1).toFixed(2)}`;
}

async function duration(src: string): Promise<number | null> {
    try {
        const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], { timeout: 10000 });
        const s = parseFloat(String(stdout).trim());
        return Number.isFinite(s) ? s : null;
    } catch {
        return null;
    }
}

/** Up to `max` JPEG stills spread across the whole video, in order, so a model that only sees photos can watch it. */
export async function videoFrames(video: Buffer, max = 6): Promise<Buffer[]> {
    if (!video.length) return [];
    const dir = await mkdtemp(join(tmpdir(), "kvvid-"));
    try {
        const src = join(dir, "in.mp4");
        await writeFile(src, video);
        await run("ffmpeg", [
            "-y", "-i", src,
            "-vf", `fps=${frameRate(await duration(src), max)},scale=768:-2`,
            "-frames:v", String(max),
            "-q:v", "5",
            join(dir, "f%02d.jpg"),
        ], { timeout: 20000 });
        const out: Buffer[] = [];
        for (let i = 1; i <= max; i++) {
            try {
                out.push(await readFile(join(dir, `f${String(i).padStart(2, "0")}.jpg`)));
            } catch {
                break;
            }
        }
        return out;
    } catch (err) {
        console.warn("[video] frames failed:", err instanceof Error ? err.message : err);
        return [];
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
