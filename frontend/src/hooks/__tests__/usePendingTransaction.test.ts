import { act, renderHook } from "@testing-library/react";
import { usePendingTransaction } from "../usePendingTransaction";

describe("usePendingTransaction", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("initializes with PENDING state for a valid txHash", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as any;
    const { result } = renderHook(() => usePendingTransaction("0xabc123"));

    expect(result.current.status).toBe("PENDING");
    expect(result.current.isLoading).toBe(true);
  });

  it("ignores stale response when a newer poll has been issued", async () => {
    let resolveFirst: (value: any) => void;
    let resolveSecond: (value: any) => void;

    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    const mockFetch = jest
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    global.fetch = mockFetch as any;

    const { result } = renderHook(() => usePendingTransaction("0xabc123"));

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance 5 seconds to trigger second poll
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Resolve second request first with SUCCESS
    await act(async () => {
      resolveSecond!({
        ok: true,
        json: async () => ({ status: "SUCCESS", ledger: 100 }),
      });
    });

    expect(result.current.status).toBe("SUCCESS");
    expect(result.current.ledger).toBe(100);

    // Now resolve first (older) request with PENDING
    await act(async () => {
      resolveFirst!({
        ok: true,
        json: async () => ({ status: "PENDING" }),
      });
    });

    // Older request should NOT overwrite SUCCESS
    expect(result.current.status).toBe("SUCCESS");
    expect(result.current.ledger).toBe(100);
  });

  it("stops polling on terminal state", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "SUCCESS", ledger: 42 }),
    });
    global.fetch = mockFetch as any;

    const { result } = renderHook(() => usePendingTransaction("0xabc123"));

    await act(async () => {
      // Allow initial check to resolve
    });

    expect(result.current.status).toBe("SUCCESS");

    // Advance timers
    act(() => {
      jest.advanceTimersByTime(15000);
    });

    // Fetch should not have been called again after terminal state
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
