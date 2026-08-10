#!/usr/bin/env bash
# Print Cosmos DB connection string for MongoDB Compass (includes password — do not commit output)
set -euo pipefail

ACCOUNT="${COSMOS_ACCOUNT:-kavach-prod-mongo}"
RG="${COSMOS_RG:-kavach-prod-rg}"
DB="${COSMOS_DB:-kavach}"

KEY=$(az cosmosdb keys list --name "$ACCOUNT" --resource-group "$RG" --type keys --query primaryMasterKey -o tsv)

echo "MongoDB Compass URI (copy below):"
echo ""
echo "mongodb://${ACCOUNT}:${KEY}@${ACCOUNT}.mongo.cosmos.azure.com:10255/${DB}?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000"
echo ""
echo "Azure Portal: Cosmos DB → ${ACCOUNT} → Settings → Keys → Primary Connection String"
echo "Database name: ${DB}"
