import express, { Request, Response } from "express";
import request from "supertest";
import { idempotency } from "../middleware/idempotency";
import RedisClient from "../lib/redis";

jest.mock("../lib/redis");
jest.mock("../lib/logger", () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  installRequestIdConsolePatch: jest.fn(),
}));

describe("Idempotency Middleware", () => {
  let app: express.Application;
  let mockRedis: {
    get: jest.Mock;
    set: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
  };

  beforeEach(() => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue("OK"),
      setex: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
    };

    (RedisClient.isRedisConnected as jest.Mock).mockReturnValue(true);
    (RedisClient.getInstance as jest.Mock).mockReturnValue(mockRedis);
    (RedisClient.connect as jest.Mock).mockResolvedValue(undefined);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res, next) => {
      req.requestId = "test-request-id";
      next();
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Error Response Caching", () => {
    beforeEach(() => {
      let callCount = 0;
      app.post(
        "/test/error",
        idempotency(),
        (req: Request, res: Response) => {
          callCount++;
          if (callCount === 1) {
            // First call fails
            res.status(400).json({ error: "Bad request" });
          } else {
            // Second call succeeds
            res.status(200).json({ success: true });
          }
        }
      );
    });

    it("should not cache 4xx error responses", async () => {
      mockRedis.get.mockResolvedValue(null);

      const key = "test-key-1";

      // First request fails with 400
      const response1 = await request(app)
        .post("/test/error")
        .set("Idempotency-Key", key)
        .send({});

      expect(response1.status).toBe(400);
      expect(response1.body).toEqual({ error: "Bad request" });

      // Verify in-flight was atomically set
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining(key),
        expect.stringContaining("in_flight"),
        "EX",
        30,
        "NX"
      );

      // Verify error was NOT cached (del was called instead)
      expect(mockRedis.del).toHaveBeenCalledWith(
        expect.stringContaining(key)
      );

      // Second request with same key should re-execute and succeed
      mockRedis.get.mockResolvedValue(null);
      const response2 = await request(app)
        .post("/test/error")
        .set("Idempotency-Key", key)
        .send({});

      expect(response2.status).toBe(200);
      expect(response2.body).toEqual({ success: true });
    });

    it("should not cache 5xx error responses", async () => {
      app.post(
        "/test/server-error",
        idempotency(),
        (_req: Request, res: Response) => {
          res.status(500).json({ error: "Internal server error" });
        }
      );

      mockRedis.get.mockResolvedValue(null);
      const key = "test-key-2";

      const response = await request(app)
        .post("/test/server-error")
        .set("Idempotency-Key", key)
        .send({});

      expect(response.status).toBe(500);

      // Verify error was NOT cached (del was called)
      expect(mockRedis.del).toHaveBeenCalledWith(
        expect.stringContaining(key)
      );
    });
  });

  describe("Success Response Caching", () => {
    beforeEach(() => {
      app.post(
        "/test/success",
        idempotency(),
        (_req: Request, res: Response) => {
          res.status(200).json({ success: true, data: "test-data" });
        }
      );
    });

    it("should cache 2xx success responses", async () => {
      mockRedis.get.mockResolvedValue(null);
      const key = "test-key-3";

      const response = await request(app)
        .post("/test/success")
        .set("Idempotency-Key", key)
        .send({});

      expect(response.status).toBe(200);

      // Verify success response was cached
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining(key),
        86400, // 24 hour TTL
        expect.stringContaining("completed")
      );

      // Verify del was NOT called for success
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it("should cache 3xx redirect responses", async () => {
      app.post(
        "/test/redirect",
        idempotency(),
        (_req: Request, res: Response) => {
          res.status(302).json({ redirect: "/new-location" });
        }
      );

      mockRedis.get.mockResolvedValue(null);
      const key = "test-key-4";

      const response = await request(app)
        .post("/test/redirect")
        .set("Idempotency-Key", key)
        .send({});

      expect(response.status).toBe(302);

      // Verify redirect was cached
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining(key),
        86400,
        expect.stringContaining("completed")
      );
    });
  });

  describe("Retry After Failure", () => {
    it("should allow retry after transient failure", async () => {
      let callCount = 0;

      app.post(
        "/test/retry",
        idempotency(),
        (_req: Request, res: Response) => {
          callCount++;
          if (callCount === 1) {
            res.status(503).json({ error: "Service temporarily unavailable" });
          } else {
            res.status(201).json({ success: true, id: "created-123" });
          }
        }
      );

      const key = "retry-key";

      // First call: Redis has no cached value
      mockRedis.get.mockResolvedValueOnce(null);

      const response1 = await request(app)
        .post("/test/retry")
        .set("Idempotency-Key", key)
        .send({});

      expect(response1.status).toBe(503);
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining(key));

      // Second call: Redis still has no cached value (error was not cached)
      mockRedis.get.mockResolvedValueOnce(null);

      const response2 = await request(app)
        .post("/test/retry")
        .set("Idempotency-Key", key)
        .send({});

      expect(response2.status).toBe(201);
      expect(response2.body).toEqual({ success: true, id: "created-123" });

      // Verify success was cached
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining(key),
        86400,
        expect.stringContaining('"success":true')
      );
    });
  });

  describe("In-Flight Request Handling", () => {
    it("should return 409 for in-flight requests", async () => {
      app.post(
        "/test/in-flight",
        idempotency(),
        (_req: Request, res: Response) => {
          res.status(200).json({ success: true });
        }
      );

      // Mock Redis atomic set to fail (NX condition fails) and get to return in-flight status
      mockRedis.set.mockResolvedValue(null);
      mockRedis.get.mockResolvedValue(JSON.stringify({ status: "in_flight" }));
      const key = "in-flight-key";

      const response = await request(app)
        .post("/test/in-flight")
        .set("Idempotency-Key", key)
        .send({});

      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty("code", "CONFLICT");
      expect(response.body).toHaveProperty("requestId", "test-request-id");
    });
  });

  describe("Cached Response Replay", () => {
    it("should replay cached successful response", async () => {
      app.post(
        "/test/cached",
        idempotency(),
        (_req: Request, res: Response) => {
          res.status(200).json({ success: true, value: "original" });
        }
      );

      const cachedResponse = {
        status: "completed",
        response: { success: true, value: "original" },
      };
      mockRedis.set.mockResolvedValue(null);
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedResponse));

      const key = "cached-key";

      const response = await request(app)
        .post("/test/cached")
        .set("Idempotency-Key", key)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, value: "original" });

      // Handler should not have been called (no new setex for completed)
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe("Concurrent Requests Race Condition", () => {
    it("should allow only one of two concurrent requests with the same key to proceed", async () => {
      let handlerExecutionCount = 0;
      app.post(
        "/test/concurrent",
        idempotency(),
        async (_req: Request, res: Response) => {
          handlerExecutionCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          res.status(200).json({ success: true, count: handlerExecutionCount });
        }
      );

      // Simulate atomic Redis SET NX EX behavior using an in-memory key-value store
      const store = new Map<string, string>();
      mockRedis.set.mockImplementation(async (key: string, val: string, ...args: unknown[]) => {
        const isNx = args.includes("NX");
        if (isNx && store.has(key)) {
          return null;
        }
        store.set(key, val);
        return "OK";
      });
      mockRedis.get.mockImplementation(async (key: string) => store.get(key) || null);
      mockRedis.setex.mockImplementation(async (key: string, _ttl: number, val: string) => {
        store.set(key, val);
        return "OK";
      });
      mockRedis.del.mockImplementation(async (key: string) => {
        store.delete(key);
        return 1;
      });

      const key = "concurrent-race-key";

      // Fire two concurrent requests with identical Idempotency-Key
      const [response1, response2] = await Promise.all([
        request(app)
          .post("/test/concurrent")
          .set("Idempotency-Key", key)
          .send({}),
        request(app)
          .post("/test/concurrent")
          .set("Idempotency-Key", key)
          .send({}),
      ]);

      const statuses = [response1.status, response2.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(handlerExecutionCount).toBe(1);

      const conflictResponse = response1.status === 409 ? response1 : response2;
      expect(conflictResponse.body).toEqual({
        code: "CONFLICT",
        error: "Request is already being processed.",
        requestId: "test-request-id",
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining(key),
        expect.stringContaining("in_flight"),
        "EX",
        30,
        "NX"
      );
    });
  });
});
