import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-950",
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-100",
        secondary:
          "border border-transparent bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-50 dark:hover:bg-gray-700",
        destructive:
          "border border-transparent bg-red-500/20 text-red-700 hover:bg-red-500/30 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30",
        outline: "border border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-300",
        high: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
        medium:
          "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
        low: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
        positive:
          "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
        negative:
          "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
        neutral:
          "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
