#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs a block and returns any raised NSException instead of process-killing.
/// HealthKit still throws ObjC exceptions from requestAuthorization in some cases.
@interface HealthKitAuthExceptionCatcher : NSObject

+ (nullable NSException *)performAndReturnException:(void (NS_NOESCAPE ^)(void))block;

@end

NS_ASSUME_NONNULL_END
