import { describe, it, expect, vi } from "vitest";
import { createMockRequest } from "../helpers/mock-request";

// Import your functions to test:
// import handler from "../../functions/my-handler";

describe("Unit test examples", () => {
  it("creates a mock request with data and session", () => {
    const req = createMockRequest({
      data: { product_id: "prod_123" },
      session: { account_id: "acc_456" },
    });

    expect(req.data.product_id).toBe("prod_123");
    expect(req.session.account_id).toBe("acc_456");
  });

  it("mocks swell.get", async () => {
    const mockGet = vi.fn().mockResolvedValue({ id: "123", name: "Test" });
    const req = createMockRequest({ swell: { get: mockGet } });

    const result = await req.swell.get("/products/{id}", { id: "123" });

    expect(result.name).toBe("Test");
    expect(mockGet).toHaveBeenCalledWith("/products/{id}", { id: "123" });
  });

  it("mocks swell.settings", async () => {
    const mockSettings = vi.fn().mockResolvedValue({
      feature: { enabled: true },
    });
    const req = createMockRequest({ swell: { settings: mockSettings } });

    const settings = await req.swell.settings();

    expect(settings.feature.enabled).toBe(true);
  });
});
