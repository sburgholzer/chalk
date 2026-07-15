import type { Metadata } from "next";
import "./globals.css";
import { AuthLayoutWrapper } from "@/components/AuthLayoutWrapper";

export const metadata: Metadata = {
  title: "Chalk — Architecture Decision Room",
  description:
    "A serverless Architecture Decision Room for collaborative decision-making with AI.",
};

export function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AuthLayoutWrapper>{children}</AuthLayoutWrapper>
      </body>
    </html>
  );
}

export { RootLayout as default };
