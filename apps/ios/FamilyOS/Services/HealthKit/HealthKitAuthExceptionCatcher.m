#import "HealthKitAuthExceptionCatcher.h"

@implementation HealthKitAuthExceptionCatcher

+ (nullable NSException *)performAndReturnException:(void (NS_NOESCAPE ^)(void))block {
    @try {
        if (block) {
            block();
        }
        return nil;
    } @catch (NSException *exception) {
        return exception;
    }
}

@end
