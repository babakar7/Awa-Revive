import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ownerPaymentsAuthHook } from "../src/admin/coachPaymentsAuth.js";

function replyDouble() {
  const reply = {
    header: vi.fn(),
    code: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
  };
  reply.header.mockReturnValue(reply);
  reply.code.mockReturnValue(reply);
  reply.type.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply & {
    code: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

describe("coach payment role guard", () => {
  it("lets an owner session through without a second password", async () => {
    const req = {
      method: "GET",
      headers: { accept: "text/html" },
      adminUser: "direction",
      adminRole: "owner",
    } as FastifyRequest;
    const reply = replyDouble();

    await ownerPaymentsAuthHook(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("blocks a team session from financial pages and mutations", async () => {
    const htmlReq = {
      method: "GET",
      headers: { accept: "text/html" },
      adminUser: "reception",
      adminRole: "team",
    } as FastifyRequest;
    const htmlReply = replyDouble();
    await ownerPaymentsAuthHook(htmlReq, htmlReply);
    expect(htmlReply.code).toHaveBeenCalledWith(403);
    expect(htmlReply.send).toHaveBeenCalledWith(expect.stringContaining("Changer de compte"));

    const postReq = {
      method: "POST",
      headers: {},
      adminUser: "reception",
      adminRole: "team",
    } as FastifyRequest;
    const postReply = replyDouble();
    await ownerPaymentsAuthHook(postReq, postReply);
    expect(postReply.code).toHaveBeenCalledWith(403);
    expect(postReply.send).toHaveBeenCalledWith("Accès propriétaire requis.");
  });
});
