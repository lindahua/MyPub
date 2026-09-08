import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { importScholarSnapshot } from "../../dist/core/scholar.js";
import { Catalog, publicationFromInput } from "../../dist/core/catalog.js";
import {
  addAuthor,
  addVenue,
  configureOwner,
} from "../../dist/core/identities.js";

test("Electron loads SQLite, supports browsing/filters/right detail pane and refresh recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-electron-"));
  const catalog = new Catalog({ root });
  await catalog.initialize("UI verification library");
  const author = await addAuthor(catalog, {
    author_key: "alice",
    preferred_name: "Alice Example",
  });
  const venue = await addVenue(catalog, {
    venue_key: "vision",
    preferred_name: "Vision Conference",
    abbreviation: "VISION",
    kind: "conference",
  });
  const publications = [];
  for (let i = 0; i < 12; i++)
    publications.push(
      await catalog.add({
        citation_key: `paper${i}`,
        title: `Visual learning paper ${String(i).padStart(2, "0")}`,
        // Both charts follow publication type, even when the linked venue kind differs.
        type: "workshop",
        publication_date: String(2026 - (i % 3)),
        venue: { name: "Vision Conference", venue_id: venue.id },
        authors: [{ name: "A. Example", author_id: author.id }],
        official_url: "https://example.org/article",
        paper_url: "https://example.org/paper.pdf",
        extra_urls: ["https://example.org/code"],
        tags: [i % 2 ? "video" : "geometry"],
      }),
    );
  await configureOwner(catalog, author.id, "profile");
  const capture = join(root, "capture.json");
  await writeFile(
    capture,
    JSON.stringify({
      profile_id: "profile",
      captured_at: "2026-09-08T00:00:00Z",
      coverage: "partial",
      entries: [
        {
          scholar_id: "entry",
          title: "Scholar example paper",
          authors: ["Alice Example"],
          year: 2026,
          citation_count: 4,
        },
      ],
    }),
  );
  await importScholarSnapshot(catalog, capture);
  const app = await electron.launch({
    args: [resolve("dist/desktop/main.js"), "--root", root],
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "Your research, at a glance" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Most cited papers" }),
    ).toBeVisible();
    await expect(page.locator(".metrics strong").first()).toHaveText("12");
    await expect(
      page.getByRole("img", {
        name: "Overall publication-type breakdown: Workshop: 12. Total: 12.",
        exact: true,
      }),
    ).toBeVisible();
    const yearBar = page.getByRole("button", {
      name: "2024: 4 publications; Workshop: 4",
      exact: true,
    });
    await yearBar.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("2024");
    await expect(tooltip.locator("li")).toHaveText(["Workshop4"]);
    await expect(tooltip.locator(".tooltip-total")).toHaveText("Total4");
    const labelBox = await yearBar.locator(".year-chart-total").boundingBox();
    const scrollBox = await page.locator(".year-chart-scroll").boundingBox();
    expect(labelBox!.y).toBeGreaterThanOrEqual(scrollBox!.y);
    await page
      .getByRole("heading", { name: "Publications by year", exact: true })
      .hover();
    await expect(tooltip).toHaveCount(0);
    await yearBar.focus();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);

    expect(
      await page
        .locator("html")
        .evaluate((el) => getComputedStyle(el).colorScheme),
    ).toBe("light");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Publications", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Browse by year" }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Browse by year" })
      .getByRole("button", { name: "2025 4", exact: true })
      .click();
    await expect(page.locator("article.entry")).toHaveCount(4);
    const title = page.getByRole("button", {
      name: "Visual learning paper 07",
      exact: false,
    });
    await title.click();
    await expect(title).toHaveAttribute("aria-expanded", "true");
    const parent = page.getByRole("complementary", { name: "Detail pane" });
    await expect(page.locator("article.entry .detail")).toHaveCount(0);
    await expect(
      parent.getByRole("region", { name: "Record details" }),
    ).toBeVisible();
    await expect(
      parent.getByRole("button", { name: "Official page ↗", exact: true }),
    ).toBeVisible();
    await expect(
      parent.getByRole("button", { name: "Paper ↗", exact: true }),
    ).toBeVisible();
    await expect(
      parent.getByRole("button", {
        name: "https://example.org/code ↗",
        exact: true,
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    const paneBounds = await parent.boundingBox();
    const mainBounds = await page.locator("main").boundingBox();
    expect(paneBounds!.x).toBeGreaterThanOrEqual(
      mainBounds!.x + mainBounds!.width - 1,
    );
    const other = page.getByRole("button", {
      name: "Visual learning paper 01",
      exact: false,
    });
    await other.click();
    await expect(title).toHaveAttribute("aria-expanded", "false");
    await expect(
      parent.getByRole("heading", {
        name: "Visual learning paper 01",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(parent).toHaveCount(0);
    await expect(other).toBeFocused();
    await other.click();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page
      .getByRole("button", { name: "+ Condition", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Filter field" })
      .selectOption("tag");
    await page.getByRole("textbox", { name: "Filter value" }).fill("video");
    await expect(page.locator("article.entry")).toHaveCount(2);
    await page.getByRole("button", { name: "Clear all", exact: true }).click();
    const target = publications[7]!;
    const snapshot = await catalog.snapshot();
    const path = join(root, snapshot.paths[target.id]!);
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      JSON.stringify({
        ...JSON.parse(original),
        title: "Externally updated paper",
      }),
    );
    await expect(
      page.getByRole("button", {
        name: "Externally updated paper",
        exact: false,
      }),
    ).toBeVisible({ timeout: 15000 });
    await writeFile(path, "{");
    await expect(page.getByRole("alert")).toContainText(
      "Showing last valid data",
      { timeout: 15000 },
    );
    await writeFile(path, original);
    await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 15000 });
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Authors", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Alice Example", exact: false })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Linked bibliography · 12 active publications",
      }),
    ).toBeVisible();
    await expect(parent).toBeVisible();
    await parent.getByRole("button", { name: "Close detail pane" }).click();
    await expect(parent).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Venues", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Vision Conference", exact: false })
      .click();
    await expect(parent).toBeVisible();
    await expect(
      parent.getByRole("heading", { name: "Vision Conference", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Google Scholar", exact: true })
      .click();
    await expect(parent).toHaveCount(0);
    await page
      .getByRole("button", { name: "Scholar example paper", exact: false })
      .click();
    await expect(parent).toBeVisible();
    await expect(
      parent.getByRole("heading", {
        name: "Scholar example paper",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Search all collections" })
      .fill("Visual learning");
    await expect(
      page.getByRole("heading", { name: "Publications · 12", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Search all collections" })
      .fill("");
    await page.setViewportSize({ width: 800, height: 850 });
    await expect(page.locator("body")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/desktop/desktop.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const sizes of [
  { main: 30, dropdown: 15, custom: false },
  { main: 7, dropdown: 3, custom: true },
]) {
  test(`paper and bibliography pagination (${sizes.custom ? "custom" : "default"} sizes)`, async () => {
    const home = await mkdtemp(join(tmpdir(), "mypub-pagination-"));
    const root = join(home, "catalog");
    const catalog = new Catalog({ root });
    await catalog.initialize("Pagination library");
    const author = await addAuthor(catalog, {
      author_key: "alice",
      preferred_name: "Alice Example",
    });
    const venue = await addVenue(catalog, {
      venue_key: "vision",
      preferred_name: "Vision Conference",
      kind: "conference",
    });
    await catalog.change((state) => {
      for (let i = 0; i < 61; i++)
        state.publications.push(
          publicationFromInput({
            citation_key: `page${i}`,
            title: `Pagination paper ${String(i).padStart(2, "0")}`,
            type: "conference",
            publication_date:
              i < 40
                ? `2026-${String(12 - Math.floor(i / 4)).padStart(2, "0")}`
                : "2025",
            authors: [
              { name: "A. Example", author_id: author.id },
              { name: "Bob Coauthor" },
            ],
            venue: { name: "Vision Conference", venue_id: venue.id },
          }),
        );
    });
    await configureOwner(catalog, author.id, "profile");
    const { importScholarSnapshot } =
      await import("../../dist/core/scholar.js");
    const capture = join(home, "capture.json");
    await writeFile(
      capture,
      JSON.stringify({
        profile_id: "profile",
        captured_at: "2026-09-01T00:00:00Z",
        coverage: "complete",
        entries: Array.from({ length: 61 }, (_, i) => ({
          scholar_id: `scholar${i}`,
          title: `Source paper ${i}`,
          year: 2026,
          citation_count: i,
        })),
      }),
    );
    await importScholarSnapshot(catalog, capture);
    if (sizes.custom) {
      await mkdir(join(home, ".config/mypub"), { recursive: true });
      await writeFile(
        join(home, ".config/mypub/config.json"),
        JSON.stringify({
          max_pagesize_main: sizes.main,
          max_pagesize_dropdown: sizes.dropdown,
        }),
      );
    }
    const app = await electron.launch({
      args: [resolve("dist/desktop/main.js"), "--root", root],
      env: { ...process.env, HOME: home },
    });
    try {
      const page = await app.firstWindow();
      const navigate = async (name: string) =>
        page
          .getByRole("navigation", { name: "Main navigation" })
          .getByRole("button", { name, exact: true })
          .click();
      const pager = page.getByRole("navigation", { name: "Main pagination" });
      await expect(
        page.getByRole("heading", { name: "Your research, at a glance" }),
      ).toBeVisible();
      await navigate("Publications");
      await expect(page.locator("article.entry")).toHaveCount(sizes.main);
      const firstTitles = await page
        .locator("article.entry .entry-title")
        .allTextContents();
      await pager.getByRole("button", { name: "Next", exact: true }).click();
      await expect(pager.getByRole("combobox")).toHaveValue("2");
      await expect(page.locator("article.entry")).toHaveCount(sizes.main);
      const secondTitles = await page
        .locator("article.entry .entry-title")
        .allTextContents();
      expect(firstTitles.filter((t) => secondTitles.includes(t))).toEqual([]);
      await pager
        .getByRole("combobox")
        .selectOption(String(Math.ceil(61 / sizes.main)));
      await expect(page.locator("article.entry")).toHaveCount(
        61 % sizes.main || sizes.main,
      );
      await expect(
        pager.getByRole("button", { name: "Next", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("textbox", { name: "Search Publications", exact: true })
        .fill("paper 00");
      await expect(page.locator("article.entry")).toHaveCount(1);
      await expect(pager.getByRole("combobox")).toHaveValue("1");
      await page
        .getByRole("textbox", { name: "Search Publications", exact: true })
        .fill("");
      await navigate("Google Scholar");
      await expect(page.locator("article.entry")).toHaveCount(sizes.main);
      await pager.getByRole("button", { name: "Next", exact: true }).click();
      await expect(pager.getByRole("combobox")).toHaveValue("2");
      await expect(page.locator("article.entry")).toHaveCount(sizes.main);
      for (const [collection, entry] of [
        ["Authors", "Alice Example"],
        ["Venues", "Vision Conference"],
      ]) {
        await navigate(collection!);
        await page
          .locator("article.entry")
          .getByRole("button", { name: entry, exact: false })
          .first()
          .click();
        const bibliography = page.locator(".bibliography").first();
        await expect(bibliography.locator(".bibliography-row")).toHaveCount(
          sizes.dropdown,
        );
        await expect(
          bibliography.locator(".bibliography-row").first(),
        ).toContainText("Pagination paper 00");
        await expect(
          bibliography.locator(".bibliography-row").first(),
        ).toContainText("A. Example, Bob Coauthor");
        await expect(
          bibliography.locator(".bibliography-row").first(),
        ).toContainText("Vision Conference · 2026");
        await bibliography
          .getByRole("combobox")
          .selectOption(String(Math.floor(40 / sizes.dropdown) + 1));
        await expect(
          bibliography.locator(".bibliography-year-heading"),
        ).toHaveText(["2026", "2025"]);
        await expect(bibliography.locator(".bibliography-row")).toHaveCount(
          sizes.dropdown,
        );
        await bibliography
          .getByRole("combobox")
          .selectOption(String(Math.ceil(61 / sizes.dropdown)));
        await expect(bibliography.locator(".bibliography-row")).toHaveCount(
          61 % sizes.dropdown || sizes.dropdown,
        );
        await bibliography
          .getByRole("button", { name: "Pagination paper 60", exact: true })
          .click();
        await expect(
          page
            .getByRole("button", { name: "Pagination paper 60", exact: false })
            .first(),
        ).toHaveAttribute("aria-expanded", "true");
        await expect(pager.getByRole("combobox")).toHaveValue(
          String(Math.ceil(61 / sizes.main)),
        );
        expect(await page.locator("article.entry").count()).toBeLessThanOrEqual(
          sizes.main,
        );
      }
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}
