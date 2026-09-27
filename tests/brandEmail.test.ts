import { afterEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { EmailProvider } from "../notifications/providers/emailProvider.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Product branding and email delivery compatibility", () => {
  it.each([undefined, "ANANTA", "Anant Health", "HealthOS"])("uses Ekavyu for platform sender label %s without changing its address", async (legacyName) => {
    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    vi.stubEnv("SMTP_USER", "test-user");
    vi.stubEnv("SMTP_PASS", "test-password");
    vi.stubEnv("SMTP_FROM_EMAIL", "noreply@anant.health");
    vi.stubEnv("SMTP_FROM_NAME", legacyName);
    const sendMail = vi.fn().mockResolvedValue({ messageId: "test-message" });
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);

    const sent = await new EmailProvider().sendEmail({ to: "patient@example.test", subject: "Ekavyu appointment", html: "<p>Your appointment is confirmed.</p>" });

    expect(sent).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Ekavyu" <noreply@anant.health>', to: "patient@example.test", subject: "Ekavyu appointment" }));
  });

  it("preserves an organization sender name and delivery configuration", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "tenant-message" });
    const createTransport = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const provider = new EmailProvider();
    const sent = await provider.sendEmail({ to: "patient@example.test", subject: "Appointment", html: "<p>Confirmed</p>" }, {
      host: "smtp.clinic.test", port: 587, secure: false, user: "clinic-user", pass: "clinic-password", fromEmail: "reception@clinic.test", fromName: "Independent Clinic",
    });

    expect(sent).toBe(true);
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: "smtp.clinic.test", auth: { user: "clinic-user", pass: "clinic-password" } }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Independent Clinic" <reception@clinic.test>' }));
  });
});
