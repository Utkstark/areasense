import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AreaSense",
  description:
    "Find the right neighborhood to rent in, based on where you work.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}