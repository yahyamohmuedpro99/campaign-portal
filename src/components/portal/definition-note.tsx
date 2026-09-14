import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';

/**
 * Puts the counting rule next to the number it produced. The brief asks that where two
 * careful people could count something two ways, the screen says which way we counted.
 */
export function DefinitionNote({ rule, note }: { rule: string; note?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="How this is counted"
                className="inline-flex size-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <p className="font-medium">{rule}</p>
        {note && <p className="mt-1 text-xs opacity-80">{note}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
