import { CircleAlert } from "lucide-react";
import { friendlyError } from "#/modules/errors/messages.ts";

/**
 * Error dentro de una pantalla que por lo demás funciona: una consulta que
 * falló, una mutación rechazada.
 *
 * Existe uno solo y compartido a propósito. Antes cada pantalla repetía el mismo
 * bloque y pintaba `error.message` en crudo; bastaba con que una consulta
 * fallara por red para que a un operario le apareciera "Failed to fetch" en
 * inglés (RN-05.10). Pasando siempre por `friendlyError`, eso no puede volver a
 * colarse pantalla por pantalla.
 *
 * `null` no pinta nada, para poder montarlo sin condicional alrededor.
 */
export function InlineError({
	error,
	className = "",
}: {
	error: unknown;
	className?: string;
}) {
	if (!error) return null;

	const { message } = friendlyError(error);

	return (
		<p
			role="alert"
			className={`flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive ${className}`}
		>
			<CircleAlert className="mt-0.5 size-4 shrink-0" />
			{message}
		</p>
	);
}
