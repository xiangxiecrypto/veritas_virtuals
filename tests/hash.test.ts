import { describe, expect, it } from "@jest/globals";
import { ethers } from "ethers";
import {
  bodyContainsHash,
  buildHashReference,
  computeChainHash,
  sha256,
} from "../src/utils/hash.js";

describe("hash utilities", () => {
  it("computes a rolling keccak chain hash", () => {
    const taskIds = ["task-a", "task-b", "task-c"];

    let expected = ethers.ZeroHash;
    for (const taskId of taskIds) {
      expected = ethers.solidityPackedKeccak256(
        ["bytes32", "string"],
        [expected, taskId],
      );
    }

    expect(computeChainHash(taskIds)).toBe(expected);
  });

  it("builds and detects hash references", () => {
    const value = "hello world";
    const ref = buildHashReference("source_data", value);

    expect(ref).toBe(`[source_hash:source_data:${sha256(value)}]`);
    expect(bodyContainsHash(`prefix ${ref} suffix`, value)).toBe(true);
    expect(bodyContainsHash("no hash here", value)).toBe(false);
  });
});

