import { toolOutput, toolOutputPart } from 'eve/tools';
import { z } from 'zod';

const resultSchema = z.object({ text: z.string(), modelImages: z.array(z.string()).optional() });

export function modelToolOutput(output: unknown) {
  const result = resultSchema.parse(output);
  const images = (result.modelImages || []).map((image) => {
    const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(image);
    if (!match) throw new Error('The saved tool image is invalid.');
    return toolOutputPart.file(match[2], { mediaType: match[1] });
  });
  return images.length
    ? toolOutput.content([toolOutputPart.text(result.text), ...images])
    : toolOutput.text(result.text);
}
