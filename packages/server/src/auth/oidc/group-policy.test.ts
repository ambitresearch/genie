import { describe, expect, it } from "vitest";
import { enforceGroupAccess, GroupAccessDeniedError, hasRequiredGroup, REQUIRED_GROUP } from "./group-policy.js";

describe("group-policy (DRO-276 AC6)", () => {
  it("REQUIRED_GROUP is the literal genie-users", () => {
    expect(REQUIRED_GROUP).toBe("genie-users");
  });

  it("hasRequiredGroup is true when claims.groups includes genie-users", () => {
    expect(hasRequiredGroup({ groups: ["genie-users"] })).toBe(true);
    expect(hasRequiredGroup({ groups: ["other-group", "genie-users"] })).toBe(true);
  });

  it("hasRequiredGroup tolerates a single-string groups claim", () => {
    expect(hasRequiredGroup({ groups: "genie-users" })).toBe(true);
    expect(hasRequiredGroup({ groups: "other-group" })).toBe(false);
  });

  it("hasRequiredGroup is false when groups is absent, empty, or lacks the group", () => {
    expect(hasRequiredGroup({})).toBe(false);
    expect(hasRequiredGroup({ groups: [] })).toBe(false);
    expect(hasRequiredGroup({ groups: ["some-other-group"] })).toBe(false);
  });

  it("hasRequiredGroup ignores non-string entries and non-array/non-string values", () => {
    expect(hasRequiredGroup({ groups: [1, null, "genie-users"] as unknown as string[] })).toBe(true);
    expect(hasRequiredGroup({ groups: { nested: true } })).toBe(false);
  });

  it("enforceGroupAccess is a no-op when the group is present", () => {
    expect(() => enforceGroupAccess({ groups: ["genie-users"] })).not.toThrow();
  });

  it("enforceGroupAccess throws GroupAccessDeniedError when the group is missing (AC6 -> 403)", () => {
    expect(() => enforceGroupAccess({ groups: ["not-genie-users"] })).toThrow(GroupAccessDeniedError);
    expect(() => enforceGroupAccess({})).toThrow(GroupAccessDeniedError);
  });

  it("enforceGroupAccess supports a custom required group", () => {
    expect(() => enforceGroupAccess({ groups: ["admins"] }, "admins")).not.toThrow();
    expect(() => enforceGroupAccess({ groups: ["genie-users"] }, "admins")).toThrow(
      GroupAccessDeniedError,
    );
  });

  it("GroupAccessDeniedError carries the required group for the HTTP layer to report", () => {
    try {
      enforceGroupAccess({});
      throw new Error("expected enforceGroupAccess to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GroupAccessDeniedError);
      expect((error as GroupAccessDeniedError).requiredGroup).toBe("genie-users");
    }
  });
});
