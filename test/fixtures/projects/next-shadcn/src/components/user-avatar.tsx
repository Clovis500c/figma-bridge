export interface UserAvatarProps {
  /** Initials shown when there is no picture */
  initials: string;
  size?: "sm" | "md" | "lg";
  online?: boolean;
}

export default function UserAvatar({ initials, size = "md", online }: UserAvatarProps) {
  return <span data-size={size} data-online={online}>{initials}</span>;
}
