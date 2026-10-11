// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Presence, PresenceSdk } from "./presence.js";
import { useDiscordPresence } from "./react.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Status({ sdk, presence }: { sdk: PresenceSdk | null; presence: Presence | null }) {
  useDiscordPresence(sdk, presence);
  return null;
}

describe("useDiscordPresence", () => {
  it("suit la présence affichée et l'efface au démontage", async () => {
    vi.useFakeTimers();
    const setActivity = vi.fn(async (_a: unknown) => null);
    const sdk: PresenceSdk = { commands: { setActivity } };
    const { rerender, unmount } = render(<Status sdk={sdk} presence={{ details: "Salon" }} />);
    await vi.advanceTimersByTimeAsync(0);
    rerender(<Status sdk={sdk} presence={{ details: "Salon" }} />); // nouvel objet, même valeur
    rerender(<Status sdk={sdk} presence={{ details: "Question 1" }} />);
    await vi.advanceTimersByTimeAsync(5000);
    unmount();
    const sent = setActivity.mock.calls.map((c) => (c[0] as { activity: unknown }).activity);
    expect(sent).toEqual([{ type: 0, details: "Salon" }, { type: 0, details: "Question 1" }, null]);
  });

  it("ne fait rien hors de Discord", () => {
    render(<Status sdk={null} presence={{ details: "x" }} />);
  });
});
