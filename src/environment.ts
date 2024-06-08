import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

export async function getEnvironment(prefix: string) {
  let variables = new Map<string, string>();
  if (process.env.AWS_REGION || process.env.AWS_PROFILE) {
    try {
      const ssmClient = new SSMClient({});

      if (!prefix.match(/\/.+\//)) {
        throw new Error("Invalid Prefix: " + JSON.stringify(prefix));
      }

      let nextToken = null;
      do {
        const response = await ssmClient.send(
          new GetParametersByPathCommand({
            MaxResults: 10,
            NextToken: nextToken,
            Path: prefix,
            Recursive: true,
            WithDecryption: true,
          }),
        );
        response.Parameters.forEach(({ Name: name, Type: type, Value: value }) => {
          variables.set(name.replace(prefix, "").toUpperCase().replace(/\W+/g, "_"), value);
        });
        nextToken = response.NextToken;
      } while (nextToken);
    } catch (e) {
      console.log(e);
    }
  }
  return variables;
}
