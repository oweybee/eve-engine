"""Render every video in manifest.json to MP4. Usage: python3 render_all.py outdir [fps]"""
import asyncio, json, os, subprocess, sys
from playwright.async_api import async_playwright
OUT = sys.argv[1]; FPS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
man = json.load(open(os.path.join(OUT, "manifest.json")))
sem = asyncio.Semaphore(4)
async def one(browser, v):
    async with sem:
        pg = await browser.new_page(viewport={"width": 1080, "height": 1920})
        await pg.goto("file://" + os.path.abspath(os.path.join(OUT, v["html"]))); await pg.wait_for_timeout(400)
        total = await pg.evaluate("window.TOTAL"); raw = os.path.join(OUT, v["html"] + ".mp4")
        ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-i", "-",
                               "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", raw], stdin=subprocess.PIPE)
        for i in range(int(FPS * total)):
            await pg.evaluate(f"render({i / FPS})")
            ff.stdin.write(await pg.screenshot(type="jpeg", quality=92))
        ff.stdin.close(); ff.wait(); await pg.close()
        final = os.path.join(OUT, v["out"])
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-i", os.path.join(OUT, v["wav"]), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                        "-af", "loudnorm=I=-14:TP=-1.5", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final], check=True)
        os.remove(raw); print("done", v["out"], flush=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await asyncio.gather(*(one(b, v) for v in man["videos"]))
        await b.close()
asyncio.run(main())
