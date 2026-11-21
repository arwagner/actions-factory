import { describe, expect, it } from "vitest";
import { validateTemplateManifest } from "../src/config/validate.js";

describe("validateTemplateManifest", () => {
  it("accepts a manifest that extends another template", () => {
    const result = validateTemplateManifest({ name: "review-only", schemaVersions: [1], extends: "default" });

    expect(result.errors).toEqual([]);
  });

  it("rejects factory.yml-only fields and requires name and schemaVersions", () => {
    const result = validateTemplateManifest({ schemaVersion: 1, template: "default" });

    expect(result.errors).toEqual([
      { path: "name", message: "required" },
      { path: "schemaVersion", message: "unknown field" },
      { path: "schemaVersions", message: "required" },
      { path: "template", message: "unknown field" },
    ]);
  });
});
