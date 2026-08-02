import { describe, it, expect } from "bun:test";
import { sanitizeBaseURL } from "../src/providers";

/**
 * Tests for URL sanitization to prevent API key exposure (S-002)
 */

describe("sanitizeBaseURL", () => {
  describe("Basic Auth Removal", () => {
    it("should remove basic auth from URL", () => {
      const url = "https://user:sk-abc123@api.mistral.ai/v1";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });

    it("should remove basic auth from http URL", () => {
      const url = "http://user:key123@localhost:1234/v1";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("http://localhost:1234/v1");
    });

    it("should handle URLs without auth", () => {
      const url = "https://api.mistral.ai/v1";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });
  });

  describe("Query Parameter Removal", () => {
    it("should remove api_key from query string", () => {
      const url = "https://api.mistral.ai/v1?api_key=sk-abc123";
      const sanitized = sanitizeBaseURL(url);
      // Trailing ? is removed - this is correct security behavior
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });

    it("should remove key from query string", () => {
      const url = "https://api.mistral.ai/v1?key=abc123";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });

    it("should remove API_KEY from query string (uppercase)", () => {
      const url = "https://api.mistral.ai/v1?API_KEY=sk-abc123";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });

    it("should remove token from query string", () => {
      const url = "https://api.example.com/v1?token=secret123";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.example.com/v1");
    });

    it("should remove access_token from query string", () => {
      const url = "https://api.example.com/v1?foo=1&access_token=secret123&bar=2";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.example.com/v1?foo=1&bar=2");
    });

    it("should remove sig and signature from query string", () => {
      const url = "https://api.example.com/v1?sig=abc&signature=def";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.example.com/v1");
    });

    it("should remove api_key from middle of query string", () => {
      const url = "https://api.mistral.ai/v1?param1=value&api_key=sk-abc123&param2=value";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1?param1=value&param2=value");
    });

    it("should remove trailing & after key removal", () => {
      const url = "https://api.mistral.ai/v1?param=value&api_key=sk-abc123";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1?param=value");
    });

    it("should remove trailing ? after key removal", () => {
      const url = "https://api.mistral.ai/v1?api_key=sk-abc123";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty string", () => {
      const url = "";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("");
    });

    it("should handle URL without protocol", () => {
      const url = "api.mistral.ai/v1?api_key=sk-abc123";
      const sanitized = sanitizeBaseURL(url);
      // Security note: Trailing ? is removed as it's not a valid URL component
      expect(sanitized).toBe("api.mistral.ai/v1");
    });

    it("should handle URL with multiple api_key params", () => {
      const url = "https://api.mistral.ai/v1?api_key=sk-abc&api_key=xyz";
      const sanitized = sanitizeBaseURL(url);
      // Security note: All api_key params removed, trailing ?& cleaned up
      expect(sanitized).toBe("https://api.mistral.ai/v1");
    });

    it("should handle URL with port", () => {
      const url = "https://user:key@localhost:1234/v1";
      const sanitized = sanitizeBaseURL(url);
      expect(sanitized).toBe("https://localhost:1234/v1");
    });
  });
});
