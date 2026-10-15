import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  await page.goto(`/__test/host${query}`);
  const frame = page.frameLocator("#widget");
  await expect(frame.getByText("测试音频", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      frame.locator("audio").evaluate((el: HTMLAudioElement) => el.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  return frame;
}
test("real audio plays, pauses, seeks by click and drag, and changes playback speed", async ({
  page,
}) => {
  const frame = await open(page),
    audio = frame.locator("audio");
  expect(await audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await frame.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(0.2);
  await frame.getByRole("button", { name: "暂停", exact: true }).click();
  const paused = await audio.evaluate((a: HTMLAudioElement) => a.currentTime);
  await page.waitForTimeout(250);
  expect(
    await audio.evaluate((a: HTMLAudioElement) => a.currentTime),
  ).toBeCloseTo(paused, 1);
  const slider = frame.getByRole("slider", { name: "播放进度" }),
    bounds = (await slider.boundingBox())!;
  await slider.click({
    position: { x: bounds.width * 0.6, y: bounds.height / 2 },
  });
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(4.5);
  await page.mouse.move(
    bounds.x + bounds.width * 0.6,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.25,
    bounds.y + bounds.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  expect(
    await audio.evaluate((a: HTMLAudioElement) => a.currentTime),
  ).toBeLessThan(3);
  await frame.getByRole("button", { name: "播放速度 1 倍" }).click();
  expect(await audio.evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(
    1.5,
  );
  await frame.getByRole("button", { name: "播放速度 1.5 倍" }).click();
  expect(await audio.evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(2);
  await frame.getByRole("button", { name: "播放速度 2 倍" }).click();
  expect(await audio.evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1);
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await frame.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(false);
});
test("transparent single bubble meets geometry, controls, true waveform and light/dark theme", async ({
  page,
}) => {
  const frame = await open(page);
  const style = await frame.locator(".bubble").evaluate((el) => {
    const s = getComputedStyle(el),
      b = el.getBoundingClientRect();
    return {
      width: b.width,
      height: b.height,
      left: b.left,
      bg: s.backgroundColor,
      shadow: s.boxShadow,
      border: s.borderWidth,
      radius: s.borderRadius,
      body: getComputedStyle(document.body).backgroundColor,
      root: getComputedStyle(document.documentElement).backgroundColor,
    };
  });
  expect(style).toMatchObject({
    width: 350,
    height: 62,
    left: 0,
    bg: "rgb(238, 233, 250)",
    shadow: "none",
    border: "0px",
    radius: "26px 26px 26px 9px",
    body: "rgba(0, 0, 0, 0)",
    root: "rgba(0, 0, 0, 0)",
  });
  await expect(frame.locator("button")).toHaveCount(2);
  await expect(frame.locator(".wave-base rect")).toHaveCount(64);
  const heights = await frame
    .locator(".wave-base rect")
    .evaluateAll((rects) => rects.map((r) => r.getAttribute("height")));
  expect(new Set(heights).size).toBeGreaterThan(30);
  await page.screenshot({
    path: "test-results/voice-bubble-light.png",
    omitBackground: true,
  });
  await page.evaluate(() =>
    (window as any).__bubbleTest.bridge.sendHostContextChange({
      theme: "dark",
    }),
  );
  await expect(frame.locator(".bubble")).toHaveCSS(
    "background-color",
    "rgb(62, 53, 87)",
  );
  await page.screenshot({
    path: "test-results/voice-bubble-dark.png",
    omitBackground: true,
  });
});
test("mobile width never exceeds 85 percent and all controls fit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 130 });
  const frame = await open(page);
  const bubble = (await frame.locator(".bubble").boundingBox())!;
  expect(bubble.width).toBeLessThanOrEqual(272);
  expect(bubble.height).toBe(62);
  const speed = (await frame.locator(".speed").boundingBox())!;
  expect(speed.x + speed.width).toBeLessThanOrEqual(bubble.x + bubble.width);
  await page.screenshot({
    path: "test-results/voice-bubble-mobile.png",
    omitBackground: true,
  });
});
test("pink is an optional server-selected palette without a settings panel", async ({
  page,
}) => {
  const frame = await open(page, "?palette=pink");
  await expect(frame.locator(".bubble")).toHaveCSS(
    "background-color",
    "rgb(250, 231, 238)",
  );
  await expect(frame.locator("button")).toHaveCount(2);
});
test("reopening reuses same saved audio ID and does not autoplay", async ({
  page,
}) => {
  let frame = await open(page);
  const id = await page.evaluate(
    () => (window as any).__bubbleTest.result.structuredContent.audioId,
  );
  await frame.getByRole("button", { name: "播放", exact: true }).click();
  await page.reload();
  frame = page.frameLocator("#widget");
  await expect(frame.getByText("测试音频", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__bubbleTest.result.structuredContent.audioId,
    ),
  ).toBe(id);
  expect(
    await frame.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(true);
  await frame.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(() =>
      frame.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeGreaterThan(0.2);
});
test("expired signed URL refreshes through the MCP Apps bridge without generation or autoplay", async ({
  page,
}) => {
  const frame = await open(page, "?expired=true");
  await expect
    .poll(() => page.evaluate(() => (window as any).__bubbleTest.calls.length))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      (window as any).__bubbleTest.calls.every(
        (x: string) => x === "get_voice_bubble",
      ),
    ),
  ).toBe(true);
  expect(
    await frame.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(true);
  await frame.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(() =>
      frame.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeGreaterThan(0.2);
});
test("loading failure is visible, refresh is bounded, and a click retries playback", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/audio/**", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          body: "unavailable",
          headers: { "Access-Control-Allow-Origin": "*" },
        })
      : route.continue(),
  );
  await page.goto("/__test/host");
  const frame = page.frameLocator("#widget");
  await expect(frame.getByText("点击重试", { exact: true })).toBeVisible();
  const count = await page.evaluate(
    () => (window as any).__bubbleTest.calls.length,
  );
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as any).__bubbleTest.calls.length),
  ).toBe(count);
  fail = false;
  await frame.getByRole("button", { name: "重试播放" }).click();
  await expect
    .poll(() =>
      frame.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeGreaterThan(0.2);
});
test("browser CSP allows signed audio and rejects undeclared destinations", async ({
  page,
}) => {
  const frame = await open(page);
  const result = await frame
    .locator("audio")
    .evaluate(async (el: HTMLAudioElement) => {
      const violation = new Promise<string>((resolve) => {
        document.addEventListener(
          "securitypolicyviolation",
          (event) => resolve(event.effectiveDirective),
          { once: true },
        );
      });
      let blocked = false;
      try {
        await fetch("https://not-declared.invalid/audio");
      } catch {
        blocked = true;
      }
      return {
        blocked,
        directive: await violation,
        duration: el.duration,
        crossOrigin: el.crossOrigin,
      };
    });
  expect(result).toMatchObject({
    blocked: true,
    directive: "connect-src",
    crossOrigin: "anonymous",
  });
  expect(result.duration).toBeCloseTo(9.105, 2);
});
