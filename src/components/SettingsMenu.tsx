import { useEffect, useState } from "react";
import { Settings, KeyRound, Info, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const STORAGE_KEY = "gstr1.geminiKey";

/**
 * "Free AI" settings. Lets the user paste their own Google AI Studio
 * (Gemini) API key. When set, the AI extraction fallback uses this key
 * (which has a generous free tier) instead of Lovable AI credits.
 *
 * Key is stored only in this browser's localStorage. It's forwarded to
 * the server function per-request and never persisted server-side.
 */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY) ?? "";
      setKey(stored);
      setHasKey(Boolean(stored.trim()));
    } catch {
      /* localStorage disabled */
    }
  }, [open]);

  const save = () => {
    try {
      const trimmed = key.trim();
      if (trimmed) {
        window.localStorage.setItem(STORAGE_KEY, trimmed);
        setHasKey(true);
        toast.success("Gemini API key saved — AI fallback will use your free-tier key");
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
        setHasKey(false);
        toast.info("Gemini API key removed — falling back to Lovable AI credits");
      }
      setOpen(false);
    } catch {
      toast.error("Could not save key (localStorage disabled)");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          aria-label="Free AI settings"
          title="Free AI settings"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Free AI</span>
          {hasKey && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
              aria-label="Custom key active"
            />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" aria-hidden="true" /> Free AI (BYO Gemini key)
          </DialogTitle>
          <DialogDescription>
            Paste your Google AI Studio API key to use Gemini's free tier for AI
            fallback extraction — no Lovable credits consumed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            <div className="mb-2 flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <div>
                <strong className="text-foreground">Extraction pipeline (0-credit first):</strong>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  <li>Local PDF text + Tesseract OCR</li>
                  <li>Auto-fix pass (recompute tax, infer missing rows)</li>
                  <li>AI fallback → your Gemini key first, Lovable credits last</li>
                </ol>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gemini-key" className="text-xs">Gemini API key</Label>
            <Input
              id="gemini-key"
              type="password"
              placeholder="AIza…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-[color:var(--brand)] hover:underline"
            >
              Get a free key from Google AI Studio
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
