import { describe, expect, it } from "vitest";
import { parseFollowUpDeliverySetting, resolveFollowUpDelivery } from "@buildwarden/shared";

describe("follow-up delivery", () => {
  it("defaults to queueing for missing or unknown settings", () => {
    expect(parseFollowUpDeliverySetting(undefined)).toBe("queue");
    expect(parseFollowUpDeliverySetting("interrupt")).toBe("queue");
    expect(parseFollowUpDeliverySetting("steer")).toBe("steer");
  });

  it("uses the preference only when the running turn can be steered", () => {
    expect(resolveFollowUpDelivery("steer", true)).toBe("steer");
    expect(resolveFollowUpDelivery("steer", false)).toBe("queue");
    expect(resolveFollowUpDelivery("queue", true)).toBe("queue");
  });

  it("picks the other delivery for the alternate action", () => {
    expect(resolveFollowUpDelivery("queue", true, true)).toBe("steer");
    expect(resolveFollowUpDelivery("steer", true, true)).toBe("queue");
    expect(resolveFollowUpDelivery("queue", false, true)).toBe("queue");
  });
});
