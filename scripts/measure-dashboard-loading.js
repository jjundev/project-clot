import fs from "node:fs";
import { chromium } from "playwright";
export async function measureDashboard(
  url,
  {
    runs = 3,
    scenarios = [
      { name: "musinsa-top", state: { src: "musinsa", cat: "top" } },
    ],
    isolateExternal = false,
  } = {},
) {
  const browser = await chromium.launch({
    executablePath: process.env.CLOT_BROWSER_EXECUTABLE || undefined,
    headless: true,
  });
  const results = [];
  try {
    for (const scenario of scenarios)
      for (let i = 0; i < runs; i++) {
        const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
          }),
          page = await context.newPage(),
          errors = [],
          network = [],
          pending = [];
        context.on("response", (response) => {
          const url = response.url();
          if (!/\/(assets\/|4910\/catalog-|musinsa\/catalog-)/.test(url))
            return;
          pending.push(
            response
              .finished()
              .then(() => response.request().sizes())
              .then((sizes) =>
                network.push({
                  name: url.split("?")[0].split("/").slice(-2).join("/"),
                  encoded: sizes.responseBodySize,
                  transfer: sizes.responseBodySize + sizes.responseHeadersSize,
                }),
              )
              .catch(() => {}),
          );
        });
        page.on("pageerror", (e) => errors.push(e.message));
        if (isolateExternal)
          await context.route(/^https:\/\//, (r) => r.abort());
        await page.addInitScript((state) => {
          for (const key of ["src", "cat", "sort", "filter"])
            if (state[key] != null)
              localStorage.setItem("clot." + key, state[key]);
        }, scenario.state);
        await page.addInitScript(() => {
          window.__measure = { first: null, ready: null, longTasks: [] };
          new PerformanceObserver((list) => {
            window.__measure.longTasks.push(
              ...list.getEntries().map((e) => e.duration),
            );
          }).observe({ type: "longtask", buffered: true });
          const timer = setInterval(() => {
            if (
              document.querySelector(".card") &&
              window.__measure.first == null
            )
              window.__measure.first = performance.now();
            const n = document.querySelector("#shownN");
            if (
              n &&
              /^\d[\d,]*$/.test(n.textContent) &&
              window.__measure.first != null
            ) {
              if (
                !window.__CLOT_DATA__?.catalog?.v ||
                window.__CLOT_DATA__.catalog.v === 1
              ) {
                window.__measure.ready = performance.now();
                clearInterval(timer);
              }
            }
          }, 10);
        });
        const started = Date.now();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForFunction(
          () => document.querySelector(".card"),
          null,
          {
            timeout: 60000,
          },
        );
        const data = await page.evaluate(() => ({
          revision: window.__CLOT_DATA__.catalog.revision,
          total: window.__CLOT_DATA__.catalog.totalItems || null,
          v: window.__CLOT_DATA__.catalog.v,
        }));
        // Readiness must reflect a real nondefault query, never the bootstrap count.
        await page.locator("#q").fill("__PERFORMANCE_NO_MATCH__");
        await page.waitForFunction(
          () => document.querySelector("#shownN").textContent === "0",
          null,
          { timeout: 120000 },
        );
        const searchReadyMs = await page.evaluate(() => performance.now());
        await page.locator("#q").fill("");
        await page.waitForFunction(
          () =>
            /^\d[\d,]*$/.test(document.querySelector("#shownN").textContent) &&
            document.querySelector("#shownN").textContent !== "0",
        );
        const sample = await page.evaluate(() => ({
          firstCardsMs: window.__measure.first,
          heap: performance.memory
            ? {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
              }
            : null,
          longTasks: window.__measure.longTasks,
          resources: performance
            .getEntriesByType("resource")
            .filter((e) =>
              /\/(assets\/|4910\/catalog-|musinsa\/catalog-)/.test(e.name),
            )
            .map((e) => ({
              name: e.name.split("?")[0].split("/").slice(-2).join("/"),
              duration: e.duration,
              encoded: e.encodedBodySize,
              decoded: e.decodedBodySize,
              transfer: e.transferSize,
              start: e.startTime,
              end: e.responseEnd,
            })),
        }));
        await Promise.all(pending);
        results.push({
          ...data,
          ...sample,
          network,
          scenario: scenario.name,
          state: scenario.state,
          indexParts: network
            .filter((x) => /\/index-/.test(x.name))
            .map((x) => x.name),
          indexEncodedBytes: network
            .filter((x) => /\/index-/.test(x.name))
            .reduce((n, x) => n + x.encoded, 0),
          searchReadyMs,
          elapsedMs: Date.now() - started,
          errors,
        });
        await context.close();
      }
  } finally {
    await browser.close();
  }
  return {
    url,
    time: new Date().toISOString(),
    conditions: {
      runs,
      scenarios,
      isolateExternal,
      viewport: "1440x1000",
      headless: true,
      network: "unthrottled",
      cpu: "unthrottled",
      note: "Heap is main-thread instantaneous Chrome JS heap; Worker memory is not included. Search readiness includes a debounced no-match query.",
    },
    results,
  };
}
if (process.argv[1]?.endsWith("measure-dashboard-loading.js")) {
  try {
    const result = await measureDashboard(process.argv[2]);
    fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify(
        result.results.map((x) => ({
          firstCardsMs: x.firstCardsMs,
          searchReadyMs: x.searchReadyMs,
          errors: x.errors,
        })),
      ),
    );
    if (result.results.some((x) => x.errors.length)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
