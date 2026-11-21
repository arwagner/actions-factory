import { describe, expect, it } from "vitest";
import { maskCommands, parseDotenv } from "../src/runner/check-env.js";

describe("parseDotenv", () => {
  it("reads dotenv lines: export, quotes, comments, escaped newlines and quoted multi-line values", () => {
    const text = [
      "# test values",
      "SIMPLE=tok1simple",
      "export SPACED = has spaces  # trailing comment",
      "SINGLE='keep $raw'",
      'DOUBLE="line1\\nline2"',
      'MULTI="first line',
      'second line"',
      "EMPTY=",
    ].join("\n");

    expect(parseDotenv(text)).toEqual({
      SIMPLE: "tok1simple",
      SPACED: "has spaces",
      SINGLE: "keep $raw",
      DOUBLE: "line1\nline2",
      MULTI: "first line\nsecond line",
      EMPTY: "",
    });
  });
});

describe("maskCommands", () => {
  it("escapes % then CR and LF, masks multi-line values line by line, and skips empty and tiny lines", () => {
    const { commands, warnings } = maskCommands({
      PCT: "tok7%41%25z",
      MULTI: "alpha-line\nQ\nbeta-line",
      EMPTY: "",
      SHORT: "t0",
    });

    expect(commands).toEqual([
      "::add-mask::tok7%2541%2525z",
      "::add-mask::alpha-line",
      "::add-mask::beta-line",
      "::add-mask::t0",
    ]);
    expect(warnings).toEqual(["::warning::FACTORY_CHECK_ENV MULTI line 2 is shorter than 3 characters and is not masked"]);
  });
});
