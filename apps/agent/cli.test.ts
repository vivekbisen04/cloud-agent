import { expect, test } from "bun:test";
import { branchName, parseArgs, shellQuote } from "./cli";

test("parses a valid task and repository", () => {
  expect(
    parseArgs([
      "--repo",
      "acme/example",
      "--task",
      "Fix the build",
      "--max-steps",
      "12",
    ]),
  ).toEqual({
    owner: "acme",
    repo: "example",
    task: "Fix the build",
    model: "google/gemini-3-flash-preview",
    maxSteps: 12,
  });
});

test("rejects invalid repository and step limits before any external calls", () => {
  expect(() =>
    parseArgs([
      "--repo",
      "https://github.com/acme/example",
      "--task",
      "Fix it",
    ]),
  ).toThrow();
  expect(() =>
    parseArgs([
      "--repo",
      "acme/example",
      "--task",
      "Fix it",
      "--max-steps",
      "0",
    ]),
  ).toThrow();
  expect(() =>
    parseArgs([
      "--repo",
      "acme/example",
      "--task",
      "Fix it",
      "--max-steps",
      "51",
    ]),
  ).toThrow();
});

test("quotes shell arguments and creates unique safe branch names", () => {
  expect(shellQuote("one'two")).toBe("'one'\\''two'");
  expect(branchName(new Date("2026-11-02T00:00:00Z"), "12345678-aaaa")).toBe(
    "cloud-agent/20261102T000000-12345678",
  );
});
