import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Catalog } from "../../dist/core/catalog.js";
import { addAuthor, addVenue } from "../../dist/core/identities.js";

test("Electron loads SQLite, supports browsing/filters/inline expansion and refresh recovery", async () => {
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
        type: "conference",
        publication_date: String(2026 - (i % 3)),
        venue: { name: "Vision Conference", venue_id: venue.id },
        authors: [{ name: "A. Example", author_id: author.id }],
        tags: [i % 2 ? "video" : "geometry"],
      }),
    );
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
    const parent = title.locator("..");
    await expect(
      parent.getByRole("region", { name: "Record details" }),
    ).toBeVisible();
    expect(
      await parent
        .locator(".detail")
        .evaluate((el) => el.getBoundingClientRect().top),
    ).toBeGreaterThan(
      await title.evaluate((el) => el.getBoundingClientRect().bottom),
    );
    const other = page.getByRole("button", {
      name: "Visual learning paper 01",
      exact: false,
    });
    await other.click();
    await expect(title).toHaveAttribute("aria-expanded", "true");
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
