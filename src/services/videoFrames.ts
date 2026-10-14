import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Up to four JPEG stills from a video, in order, so a model that only sees photos can watch it. */
export async function videoFrames(video: Buffer, max = 4): Promise<Buffer[]> {
    if (!video.length) return [];
    const dir = await mkdtemp(join(tmpdir(), "kvvid-"));
    try {
        const src = join(dir, "in.mp4");
        await writeFile(src, video);
        await run("ffmpeg", [
            "-y", "-i", src,
            "-vf", "fps=1,scale=768:-2",
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
