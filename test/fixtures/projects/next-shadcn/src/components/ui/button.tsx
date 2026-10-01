import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:bg-primary/90",
      destructive: "bg-destructive text-white",
      outline: "border bg-background",
      secondary: "bg-secondary text-secondary-foreground",
      ghost: "hover:bg-accent",
      link: "text-primary underline-offset-4 hover:underline",
    },
    size: {
      default: "h-9 px-4 py-2",
      sm: "h-8 rounded-md px-3",
      lg: "h-10 rounded-md px-6",
      icon: "size-9",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function Button({ className, variant, size, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
