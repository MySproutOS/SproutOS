import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2"
import nodemailer from "nodemailer"

export type EmailMessage = {
  from: string
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<{ messageId: string }>
}

export class SesV2Transport implements EmailTransport {
  constructor(private readonly client = new SESv2Client({ region: required("AWS_REGION") })) {}

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: message.html, Charset: "UTF-8" },
              Text: { Data: message.text, Charset: "UTF-8" },
            },
          },
        },
      }),
    )
    if (result.MessageId === undefined) throw new Error("SES accepted no message id")
    return { messageId: result.MessageId }
  }
}

export class SmtpTransport implements EmailTransport {
  private readonly client

  constructor(url = required("SMTP_URL")) {
    this.client = nodemailer.createTransport(url)
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const result = await this.client.sendMail(message)
    return { messageId: result.messageId }
  }
}

export function emailTransport(): EmailTransport {
  const kind = process.env.EMAIL_TRANSPORT ?? "smtp"
  if (kind === "smtp") return new SmtpTransport()
  if (kind === "sesv2") return new SesV2Transport()
  throw new Error("EMAIL_TRANSPORT must be smtp or sesv2")
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}
