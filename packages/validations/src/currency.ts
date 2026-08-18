import { z } from "zod";

/**
 * Monedas en las que se puede pagar un sueldo.
 *
 * **No son códigos ISO 4217 todos ellos**: junto al peso cubano, el dólar y el
 * euro conviven monedas y tarjetas de uso interno (MLC, Tropical, Clásica). Por eso
 * el vocabulario se declara aquí, cerrado y con su etiqueta, en vez de tirar de una
 * lista estándar que no las contiene.
 *
 * Lo consumen la compensación de la [spec 02] y, cuando llegue, la nómina de la
 * [spec 17]: el importe nunca viaja sin su moneda.
 */
export const currencySchema = z.enum([
	"CUP",
	"USD",
	"EUR",
	"MLC",
	"TRO",
	"CLA",
]);

export type Currency = z.infer<typeof currencySchema>;

/** Moneda por defecto cuando no se elige otra. */
export const DEFAULT_CURRENCY: Currency = "CUP";

export const CURRENCY_LABELS: Record<Currency, string> = {
	CUP: "Moneda nacional",
	USD: "Dólares",
	EUR: "Euros",
	MLC: "Moneda libremente convertible",
	TRO: "Tropical",
	CLA: "Clásica",
};

export const CURRENCIES = currencySchema.options;
