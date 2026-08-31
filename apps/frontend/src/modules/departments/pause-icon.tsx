import { Pause } from "lucide-react";

/**
 * `Pause` de lucide, envuelto para que el icono de pausa sea el mismo en el badge
 * y en el menú de acciones sin repetir clases en dos sitios.
 */
export function PauseIcon() {
	return <Pause className="fill-current" />;
}
