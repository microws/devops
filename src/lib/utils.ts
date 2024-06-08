type MicrowsPackageConfig = {
  awsProfile: string;
  service: string;
  devUrl: string;
  port: number;
  assetBucket: string;
  env: "prod" | "dev";
};
export function loadPackageConfig(): MicrowsPackageConfig {
  return Object.entries(process.env)
    .filter(([key, value]) => {
      if (key.match(/npm_package_config_microws_/)) {
        return true;
      }
    })
    .reduce(
      (acc, [key, value]) => {
        key = key.replace(/npm_package_config_microws_/, "");
        let parsedValue: string | number;
        if (["port"].includes(key)) {
          parsedValue = parseInt(value);
        } else {
          parsedValue = String(value);
        }
        acc[key] = parsedValue;
        return acc;
      },
      { env: process.env.NODE_ENV || "dev" } as MicrowsPackageConfig,
    );
}

export async function devSetup() {
  const { service, env } = loadPackageConfig();

  await import("../environment.js").then(async ({ getEnvironment }) => {
    (await getEnvironment(`/${service}/${env}/`)).forEach((value, key) => {
      console.log(`SETTING ENV[${key}]=${value}`);
      process.env[key] = value;
    });
  });
}
