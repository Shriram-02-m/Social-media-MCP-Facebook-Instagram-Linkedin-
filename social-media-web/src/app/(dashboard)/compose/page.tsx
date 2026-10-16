import { Composer } from "./composer";

export default function ComposePage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Composer</h1>
        <p className="text-sm text-muted-foreground">
          Create image, video, carousel, and text posts for Facebook, Instagram, and LinkedIn.
        </p>
      </div>
      <Composer />
    </>
  );
}
