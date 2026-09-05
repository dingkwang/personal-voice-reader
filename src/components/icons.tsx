import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m8 5 11 7-11 7V5Z" fill="currentColor" />
  </IconBase>
);

export const PauseIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M7 5h3v14H7zm7 0h3v14h-3z" fill="currentColor" />
  </IconBase>
);

export const UploadIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </IconBase>
);

export const MicIcon = (props: IconProps) => (
  <IconBase {...props}>
    <rect height="12" rx="4" stroke="currentColor" strokeWidth="1.8" width="7" x="8.5" y="2" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v4m-3 0h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
  </IconBase>
);

export const PlusIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
  </IconBase>
);

export const BackIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m14.5 6-6 6 6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
  </IconBase>
);

export const ForwardIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m9.5 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
  </IconBase>
);

export const CloseIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
  </IconBase>
);

export const CheckIcon = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
  </IconBase>
);
