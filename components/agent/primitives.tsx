"use client";
import type { ButtonHTMLAttributes } from "react";
export function WorkButton({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button
      type="button"
      className={`agent-button agent-button-${variant} ${className}`}
      {...props}
    />
  );
}
