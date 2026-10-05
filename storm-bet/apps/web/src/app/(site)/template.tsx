/** Re-mounted on every navigation: a short fade so page changes feel smooth, not jumpy. */
export default function SiteTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-in space-y-6">{children}</div>;
}
