import { Badge } from "@/components/ui/badge";
import { audienceLabel, type Audience } from "./theme";

export function AudienceBadge({ audience }: { audience: Audience }) {
  return (
    <Badge variant="outline" aria-label={`Audience: ${audienceLabel(audience)}`}>
      {audienceLabel(audience)}
    </Badge>
  );
}
