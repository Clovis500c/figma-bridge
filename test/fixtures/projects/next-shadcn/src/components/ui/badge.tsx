import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva("inline-flex items-center rounded-md border px-2 py-0.5 text-xs", {
  variants: { variant: { default: "bg-primary", secondary: "bg-secondary", outline: "text-foreground" } },
});

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={badgeVariants({ variant })} {...props} />;
}
