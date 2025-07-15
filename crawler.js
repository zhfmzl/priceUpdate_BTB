// ⚙️ 최적화된 MongoDB 연결 관리 + 크롤링 코드
import { chromium } from "playwright-core";
import mongoose from "mongoose";
import Price from "./models/price.js";
import PlayerReports from "./models/playerReports.js";
import playerRestrictions from "./seed/playerRestrictions.json" assert { type: "json" };
import pLimit from "p-limit";
let browser;

if (process.env.NODE_ENV !== "production") {
  const dotenv = await import("dotenv");
  dotenv.config();
}

const MONGODB_URL = process.env.MONGODB_URL;

// 📌 연결을 사용할 때만 연결하고 자동 해제하는 유틸 함수
async function withDB(callback) {
  try {
    await mongoose.connect(MONGODB_URL, { bufferCommands: false });
    return await callback();
  } finally {
    await mongoose.disconnect();
  }
}

// 🔧 브라우저 초기화
async function initBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log("🔄 Previous browser closed");
    } catch (error) {
      console.error("⚠ Error closing previous browser:", error.message);
    }
  }

  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable"
        : undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--no-zygote",
    ],
    ignoreHTTPSErrors: true,
  });

  console.log("✅ Playwright browser initialized");
}

// 📵 이미지 등 리소스 차단
async function blockUnwantedResources(page) {
  await page.route("**/*", (route) => {
    const blockedTypes = new Set([
      "image",
      "font",
      "stylesheet",
      "media",
      "texttrack",
      "fetch",
      "eventsource",
      "websocket",
      "manifest",
      "other",
    ]);
    const blockedDomains = ["google-analytics.com", "doubleclick.net"];
    const url = route.request().url();

    if (
      blockedTypes.has(route.request().resourceType()) ||
      blockedDomains.some((domain) => url.includes(domain))
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

// 💰 크롤링하여 가격 정보 수집
async function playerPriceValue(data, Grade, concurrency = 10) {
  let grades = Array.isArray(Grade) ? [...Grade] : [Grade];
  const limit = pLimit(concurrency);
  const results = [];

  await initBrowser();
  const context = await browser.newContext();

  const tasks = data.map((player) =>
    limit(async () => {
      if (playerRestrictions.includes(Number(player.id))) return;

      const { id } = player;

      for (let grade of grades) {
        const url = `https://fconline.nexon.com/DataCenter/PlayerInfo?spid=${id}&n1Strong=${grade}`;
        const page = await context.newPage();
        await blockUnwantedResources(page);

        try {
          console.log(`🌍 Navigating to ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded" });

          await page.waitForFunction(
            () => {
              const element = document.querySelector(".txt strong");
              return (
                element &&
                element.getAttribute("title") &&
                element.getAttribute("title").trim() !== ""
              );
            },
            { timeout: 80000 }
          );

          let datacenterTitle = await page.evaluate(() => {
            const element = document.querySelector(".txt strong").textContent;
            return element;
          });

          results.push({
            id: id,
            prices: { grade, price: datacenterTitle },
          });

          console.log(`✔ ID ${id} / Grade ${grade} → ${datacenterTitle}`);
        } catch (err) {
          console.error(`❌ Error for ID ${id}, Grade ${grade}:`, err.message);
        } finally {
          await page.close();
        }
      }
    })
  );

  await Promise.all(tasks);

  await context.close();
  await browser.close();

  return results;
}

// 📦 DB 저장
async function saveToDB(results) {
  await withDB(async () => {
    const bulkOps = results.map(({ id, prices }) => ({
      updateOne: {
        filter: { id: String(id), "prices.grade": prices.grade },
        update: { $set: { "prices.$[elem].price": prices.price } },
        arrayFilters: [{ "elem.grade": prices.grade }],
        upsert: true,
      },
    }));

    if (bulkOps.length > 0) {
      await Price.bulkWrite(bulkOps);
      console.log("📦 MongoDB updated");
    } else {
      console.log("⚠ No data to save");
    }
  });
}

// 🧠 선수 목록 검색
async function playerSearch(selectedSeason = "", minOvr = 0) {
  return await withDB(async () => {
    let selectedSeasons = Array.isArray(selectedSeason)
      ? [...selectedSeason]
      : [selectedSeason];
    const seasonNumbers = selectedSeasons.map((s) =>
      Number(String(s).slice(-3))
    );

    const inputplayer = "";
    const queryCondition = [{ name: new RegExp(inputplayer) }];

    if (minOvr && minOvr > 10) {
      queryCondition.push({
        "능력치.포지션능력치.최고능력치": { $gte: Number(minOvr) },
      });
    }

    let playerReports = [];

    if (seasonNumbers.length > 0) {
      for (let sn of seasonNumbers) {
        const base = sn * 1000000;
        queryCondition.push({ id: { $gte: base, $lte: base + 999999 } });

        const found = await PlayerReports.find({ $and: queryCondition })
          .populate({
            path: "선수정보",
            populate: { path: "prices", model: "Price" },
          })
          .populate({
            path: "선수정보.시즌이미지",
            populate: { path: "시즌이미지", model: "SeasonId" },
          })
          .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
          .limit(10000);

        queryCondition.pop();
        playerReports = playerReports.concat(found);
      }
    } else {
      const found = await PlayerReports.find({ $and: queryCondition })
        .populate({
          path: "선수정보",
          populate: { path: "prices", model: "Price" },
        })
        .populate({
          path: "선수정보.시즌이미지",
          populate: { path: "시즌이미지", model: "SeasonId" },
        })
        .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
        .limit(10000);

      playerReports = found;
    }

    return playerReports;
  });
}

async function main() {
  try {
    // --------------------------------------   2012 KH--------------------------------------

    const BTB_LIST = await playerSearch([256], 0); // playerSearch(시즌넘버, 최소오버롤)
    let BTB_RESULTS = await playerPriceValue(
      BTB_LIST,
      [1, 2, 3, 4, 5, 6, 7, 8]
    ); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(BTB_RESULTS);

    // -------------------------------------------------------------------------------------------------------------------------------

    console.log("✅ Crawling process completed.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error in crawler:", error.message);
    process.exit(1);
  }
}

main();
