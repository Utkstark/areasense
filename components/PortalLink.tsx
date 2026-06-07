'use client';

import { ExternalLink } from 'lucide-react';

interface PortalLinkProps {
  href: string;
  label: string;
  compact?: boolean;
}

export function PortalLink({ href, label, compact = false }: PortalLinkProps) {
  const sizeClasses = compact ? 'px-2 py-0.5' : 'px-2.5 py-1';
  const className = `inline-flex items-center gap-1 rounded border ${sizeClasses} text-xs hover:bg-accent hover:text-accent-foreground transition-colors`;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}