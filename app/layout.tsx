import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grok Canvas · AIGC 创作工作台",
  description: "从创意到成片：Agent、导演台与无限画布，一站式组织脚本、参考图、分镜和视频。",
  icons:{icon:"/grok-studio-mark.svg",apple:"/grok-studio-mark.svg"},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" themes={["light","dark","paper"]} enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
