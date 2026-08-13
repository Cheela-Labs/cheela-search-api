import { egress } from "../../infra/egress";
import { createOpenRouterModel } from "../../infra/model/openrouter";
import { config } from "../../shared/config";
import {
	alwaysInformational,
	type Classifier,
	createClassifier,
} from "./classifier";

export {
	alwaysInformational,
	type Classifier,
	createClassifier,
} from "./classifier";
export {
	routeStructurally,
	type StructuralRoute,
	skipsRetrieval,
} from "./structural";

/**
 * The classifier this service uses.
 *
 * A *cheaper* model than composition, deliberately. Routing picks one of three
 * words and runs on every query; composition writes the answer and runs once.
 * Pinning a different model per stage is what the model seam was for, and this
 * is the first stage to actually use it.
 */
export const classifier: Classifier = config.COMPOSER_API_KEY
	? createClassifier(
			createOpenRouterModel(
				config.COMPOSER_API_KEY,
				config.ROUTER_MODEL,
				egress,
			),
		)
	: alwaysInformational;
