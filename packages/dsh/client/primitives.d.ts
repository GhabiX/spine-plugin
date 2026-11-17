// The web client's shared atom library. The shell provides it at runtime
// through its module table, so the package is not installed; only the props
// this dock passes are declared.
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ReactNode } from "react";

  interface IconProps {
    size?: number;
  }

  interface ButtonProps {
    type?: "button";
    variant?: "ghost";
    size?: "sm";
    className?: string;
    "aria-label"?: string;
    onClick?: () => void;
    children?: ReactNode;
  }

  interface TooltipProps {
    label: string;
    side?: "top";
    delayMs?: number;
    onlyWhenClipped?: boolean;
    portal?: boolean;
    children?: ReactNode;
  }

  interface StateDotProps {
    state?: "idle" | "ongoing";
  }

  export const Button: (props: ButtonProps) => ReactNode;
  export const Tooltip: (props: TooltipProps) => ReactNode;
  export const StateDot: (props: StateDotProps) => ReactNode;
  export const IconBranchOutlineRegular: (props: IconProps) => ReactNode;
  export const IconChevronDownOutlineRegular: (props: IconProps) => ReactNode;
  export const IconChevronRightOutlineRegular: (props: IconProps) => ReactNode;
  export const IconChevronUpOutlineRegular: (props: IconProps) => ReactNode;
  export const IconCheckCircleOutlineRegular: (props: IconProps) => ReactNode;
  export const IconCloseCircleFillRegular: (props: IconProps) => ReactNode;
  export const IconCompactOutlineRegular: (props: IconProps) => ReactNode;
  export const IconInspectOutlineRegular: (props: IconProps) => ReactNode;
  export const IconStopFillRegular: (props: IconProps) => ReactNode;
  export const IconWarningTriangleOutlineRegular: (props: IconProps) => ReactNode;
}
