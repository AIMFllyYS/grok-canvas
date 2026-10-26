/** Run in the goal's existing Ego Lite TaskSpace; this never creates another browser. */
export async function inspectStudio(task, { outputDir, widths = [1440, 768, 375] } = {}) {
  if (!outputDir) throw new Error("An absolute QA outputDir is required");
  const page = task.page("p1"), report = [], fs = await import("node:fs/promises");
  await fs.mkdir(outputDir, { recursive: true });
  await page.evaluate(() => {
    window.__studioQAErrors ??= [];
    if (window.__studioQAInstalled) return;
    window.__studioQAInstalled = true;
    addEventListener("error", e => window.__studioQAErrors.push(e.message));
    addEventListener("unhandledrejection", e => window.__studioQAErrors.push(String(e.reason)));
  });
  try {
    for (const width of widths) {
      await page.cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 812 : 1000, deviceScaleFactor: 1, mobile: true });
      for (const mode of ["canvas", "director"]) {
        await page.evaluate(mode => {
          const text = mode === "canvas" ? "创作画布" : "导演台";
          [...document.querySelectorAll(".studio-mode-switch button")].find(b => b.textContent.trim() === text)?.click();
        }, mode);
        await page.waitForFunction(mode => document.querySelector(".studio-app")?.getAttribute("data-mode") === mode, mode);
        if (width < 1001) await page.waitForFunction(() => getComputedStyle(document.querySelector(".studio-edge-panel")).visibility === "hidden");
        for (const view of mode === "director" ? ["brief", "script", "refs", "shots", "archive"] : ["canvas", "agent"]) {
          if (mode === "director") await page.evaluate(view => {
            const select = document.querySelector('select[aria-label="导演台视图"]');
            select.value = view; select.dispatchEvent(new Event("change", { bubbles: true }));
          }, view);
          if (view === "agent") {
            await page.evaluate(() => document.querySelector('button[aria-label="展开创作 Agent"]')?.click());
            await page.waitForSelector(".pre-floating:not([hidden])");
          }
          await page.waitForFunction(() => [...document.images].filter(i => i.offsetWidth > 0).every(i => i.complete));
          const value = await page.evaluate(({ width, mode, view }) => {
            const panel = document.querySelector(".pre-floating:not([hidden])")?.getBoundingClientRect();
            return { targetWidth: width, width: innerWidth, mode, view, overflow: document.documentElement.scrollWidth > innerWidth, headerOverflow: document.querySelector(".studio-topbar").scrollWidth > innerWidth, sidebarHidden: getComputedStyle(document.querySelector(".studio-edge-panel")).visibility === "hidden", panelInside: !panel || panel.left >= 0 && panel.right <= innerWidth + 1 && panel.top >= 52 && panel.bottom <= innerHeight + 1, brokenImages: [...document.images].filter(i => i.offsetWidth > 0 && i.complete && !i.naturalWidth).map(i => i.src), errors: [...window.__studioQAErrors], alerts: [...document.querySelectorAll('[role="alert"]')].filter(e => e.offsetWidth > 0).map(e => e.textContent) };
          }, { width, mode, view });
          report.push(value);
          if (value.overflow || value.headerOverflow || !value.panelInside || value.brokenImages.length || value.errors.length || Math.abs(value.width - width) > 2) throw new Error(`Studio QA failed: ${JSON.stringify(value)}`);
          await page.screenshot({ path: `${outputDir}/${width}-${mode}-${view}.png` });
          if (view === "agent") await page.evaluate(() => document.querySelector('button[aria-label="收起 Agent"]')?.click());
        }
      }
    }
  } finally {
    await page.cdp("Emulation.clearDeviceMetricsOverride", {});
    await fs.writeFile(`${outputDir}/layout-report.json`, JSON.stringify(report, null, 2));
  }
  return report;
}
