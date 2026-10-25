/** Ego Lite QA. Import this module from ego-browser nodejs and pass the goal's TaskSpace. */
export async function inspectStudio(
  task,
  { outputDir, widths = [1440, 375] } = {},
) {
  const page = task.page("p1"),
    report = [];
  const fs = await import("node:fs/promises");
  await fs.mkdir(outputDir, { recursive: true });
  for (const width of widths) {
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height: width < 600 ? 812 : 1000,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    const observed=await page.cdp("Runtime.evaluate",{expression:"innerWidth",returnByValue:true});
    if(Math.abs(observed.result.value-width)>2){const scale=width/observed.result.value;await page.cdp("Emulation.setDeviceMetricsOverride",{width:Math.round(width*scale),height:Math.round((width<600?812:1000)*scale),deviceScaleFactor:1,mobile:width<600});}
    for (const mode of ["Agent", "导演台"]) {
      await page.cdp("Runtime.evaluate", {
        expression: `(async()=>{[...document.querySelectorAll('.studio-mode-switch button')].find(b=>b.textContent.trim()===${JSON.stringify(mode)})?.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const tabs =
        mode === "导演台"
          ? ["简报", "剧本", "素材", "分镜", "成片"]
          : ["对话"];
      for (const tab of tabs) {
        if (tab !== "对话")
          await page.cdp("Runtime.evaluate", {
            expression: `(async()=>{const select=document.querySelector('select[aria-label="导演台视图"]');const values={简报:'brief',剧本:'script',素材:'refs',分镜:'shots',成片:'archive'};if(!select)throw Error('Director selector missing');select.value=values[${JSON.stringify(tab)}];select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`,
            awaitPromise: true,
            returnByValue: true,
          });
        await page.cdp("Runtime.evaluate",{expression:"Promise.race([Promise.all([...document.images].filter(i=>i.offsetWidth>0&&!i.complete).map(i=>new Promise(r=>{i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true})}))),new Promise(r=>setTimeout(r,3000))])",awaitPromise:true});
        const state = await page.cdp("Runtime.evaluate", {
          expression: `JSON.stringify({width:innerWidth,appearance:document.querySelector('.studio-app')?.dataset.appearance,mode:document.querySelector('.studio-app')?.dataset.mode,tab:${JSON.stringify(tab)},overflow:document.documentElement.scrollWidth>innerWidth,appWidth:document.querySelector('.studio-app')?.getBoundingClientRect().width,visible:document.querySelector('.studio-topbar')?.getBoundingClientRect().width>0,brokenImages:[...document.images].filter(i=>i.offsetWidth>0&&i.complete&&!i.naturalWidth).map(i=>i.src),errors:window.__studioQAErrors??[],alerts:[...document.querySelectorAll('[role=alert]')].filter(e=>e.offsetWidth>0).map(e=>e.textContent)})`,
          returnByValue: true,
        });
        const value = JSON.parse(state.result.value);
        report.push(value);
        if (value.overflow || !value.visible || value.brokenImages.length || value.errors.length || Math.abs(value.width-width)>2)
          throw new Error(`Studio layout QA failed: ${JSON.stringify(value)}`);
        const shot = await page.cdp("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        await fs.writeFile(
          `${outputDir}/${width}-${mode}-${tab}.png`,
          Buffer.from(shot.data, "base64"),
        );
      }
    }
  }
  await page.cdp("Emulation.clearDeviceMetricsOverride");
  await fs.writeFile(
    `${outputDir}/layout-report.json`,
    JSON.stringify(report, null, 2),
  );
  return report;
}
