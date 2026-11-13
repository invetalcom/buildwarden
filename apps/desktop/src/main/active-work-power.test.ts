import { expect, it, vi } from "vitest";
import { ActiveWorkPower } from "./active-work-power";

it("holds one blocker across overlapping work and releases on idle and shutdown", () => {
  const blocker = { start: vi.fn(() => 0), stop: vi.fn() };
  const power = new ActiveWorkPower(blocker);
  power.setActive(false);
  power.setActive(true);
  power.setActive(true); // another worker, or one worker ends while another still runs
  expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
  expect(blocker.stop).not.toHaveBeenCalled();
  power.setActive(false);
  expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  power.setActive(true);
  power.dispose();
  power.dispose();
  power.setActive(true);
  expect(blocker.start).toHaveBeenCalledTimes(2);
  expect(blocker.stop).toHaveBeenCalledTimes(2);
});
